-- 租户命令的执行机构：认领 / 完成 / 回收（M0）
--
-- 为什么需要这一层：`record_tenant_command_attempt` 是唯一能推进终态的函数，
-- 但在它之前，库里没有任何东西表达「谁在发、发了多久没回」。没有租约就无法区分
-- 「还没轮到」和「worker 已经死了」，命令会永久停在 `pending`。
--
-- 三条边（其余边保持不变，运营端能做的仍然只有 cancel / retry）：
--   claim    : pending|retrying → dispatching，写 claimer 与租约
--   complete : dispatching → 终态，内部转调 record（不复制它的落库逻辑）
--   reap     : 租约过期 → 记一次 timeout 退回 pending；次数用尽则落 failed/permanent
--
-- 只授 service_role：认领与完成是机器的事，运营端不该能伪造「我发了」。

ALTER TABLE ops.tenant_commands
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN claimed_by text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts > 0);

-- `dispatching` = 「已在某人手上，请求可能已经发出去」。
-- 因此它**不可取消**（allowed_command_actions 对它返回空）：HTTP 请求收不回来，
-- 标成 cancelled 会让远端真建了租户、本地却说没发生过。
ALTER TABLE ops.tenant_commands DROP CONSTRAINT tenant_commands_status_check;

ALTER TABLE ops.tenant_commands
  ADD CONSTRAINT tenant_commands_status_check CHECK (
    status IN (
      'pending',
      'retrying',
      'dispatching',
      'succeeded',
      'failed',
      'cancelled'
    )
  );

-- 在途必须有主。没有 claimed_by 的 dispatching 行既回收不了也完不成，是死行。
ALTER TABLE ops.tenant_commands
  ADD CONSTRAINT tenant_commands_dispatch_check CHECK (
    status <> 'dispatching'
    OR (claimed_by IS NOT NULL AND lease_expires_at IS NOT NULL)
  );

CREATE INDEX tenant_commands_lease_idx ON ops.tenant_commands (lease_expires_at)
WHERE
  status = 'dispatching';


CREATE OR REPLACE FUNCTION ops.claim_tenant_commands (
  p_worker text,
  p_limit integer DEFAULT 10,
  p_lease interval DEFAULT interval '5 minutes'
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  claimed jsonb;
begin
  if p_worker is null or btrim(p_worker) = '' then
    return jsonb_build_object('status', 'invalid_worker');
  end if;

  -- 上限写死 100：一次认领太多会让单次 HTTP 超时把整批租约一起拖过期。
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    return jsonb_build_object('status', 'invalid_limit');
  end if;

  if p_lease is null or p_lease <= interval '0' then
    return jsonb_build_object('status', 'invalid_lease');
  end if;

  with picked as (
    select target.id
    from ops.tenant_commands as target
    where
      target.status in ('pending', 'retrying')
      and (target.next_retry_at is null or target.next_retry_at <= now())
      and target.attempt_count < target.max_attempts
    order by coalesce(target.next_retry_at, target.created_at), target.created_at
    limit p_limit
    for update skip locked
  ), updated as (
    update ops.tenant_commands as target
    set
      status = 'dispatching',
      claimed_at = now(),
      claimed_by = p_worker,
      lease_expires_at = now() + p_lease,
      version = target.version + 1
    from picked
    where target.id = picked.id
    returning
      target.id,
      target.command_no,
      target.command_type,
      target.mapping_id,
      target.attempt_count,
      target.expected_sync_version,
      target.request_summary
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', updated.id,
          'commandNo', updated.command_no,
          'commandType', updated.command_type,
          'mappingId', updated.mapping_id,
          'attemptCount', updated.attempt_count,
          'expectedSyncVersion', updated.expected_sync_version,
          'payload', updated.request_summary
        )
        order by updated.command_no
      ),
      '[]'::jsonb
    )
  into claimed
  from updated;

  return jsonb_build_object(
    'status', 'ok',
    'commands', claimed,
    'count', jsonb_array_length(claimed)
  );
end;
$$;


CREATE OR REPLACE FUNCTION ops.complete_tenant_command (
  p_command_id uuid,
  p_worker text,
  p_outcome text,
  p_http_status integer DEFAULT NULL,
  p_error_category text DEFAULT NULL,
  p_error_code text DEFAULT NULL,
  p_response_summary jsonb DEFAULT NULL,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  command_entry record;
begin
  select * into command_entry
  from ops.tenant_commands as target
  where target.id = p_command_id
  for update;

  if not found then
    return jsonb_build_object('status', 'command_not_found');
  end if;

  if command_entry.status <> 'dispatching' then
    return jsonb_build_object(
      'status', 'not_dispatching',
      'current_status', command_entry.status
    );
  end if;

  -- 租约持有人校验：过期不是「谁都能接」，而是「谁都不能写」——
  -- 回收器先动手，原 worker 回来时才会拿到 lease_expired 而不是覆盖结果。
  if command_entry.claimed_by is distinct from p_worker then
    return jsonb_build_object(
      'status', 'lease_holder_mismatch',
      'claimed_by', command_entry.claimed_by
    );
  end if;

  if command_entry.lease_expires_at < now() then
    return jsonb_build_object('status', 'lease_expired');
  end if;

  return ops.record_tenant_command_attempt(
    p_command_id,
    p_outcome,
    p_http_status,
    p_error_category,
    p_error_code,
    p_response_summary,
    p_request_id,
    null
  );
end;
$$;


CREATE OR REPLACE FUNCTION ops.reap_tenant_commands (
  p_grace interval DEFAULT interval '1 minute',
  p_limit integer DEFAULT 20
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  expired record;
  reaped integer := 0;
  exhausted integer := 0;
  skipped integer := 0;
  outcome jsonb;
begin
  -- `record_tenant_command_attempt` 在 `mapping_id` 为空时会抛
  -- `record "mapping_entry" is not assigned yet`（既有缺陷）。回收是批处理，
  -- 一条这样的行会把整批连带事务一起打挂，所以这里先跳过并单独计数，
  -- 让它在返回值里可见，而不是让回收器整体停摆。
  select count(*)::integer into skipped
  from ops.tenant_commands as target
  where
    target.status = 'dispatching'
    and target.mapping_id is null
    and target.lease_expires_at < now() - coalesce(p_grace, interval '0');

  for expired in
    select target.id, target.attempt_count, target.max_attempts
    from ops.tenant_commands as target
    where
      target.status = 'dispatching'
      and target.mapping_id is not null
      and target.lease_expires_at < now() - coalesce(p_grace, interval '0')
    order by target.lease_expires_at
    limit coalesce(p_limit, 20)
    for update skip locked
  loop
    -- 次数用尽就落永久失败：再退回 pending 只会让这条命令永远在队列里转圈。
    if expired.attempt_count + 1 >= expired.max_attempts then
      outcome := ops.record_tenant_command_attempt(
        expired.id,
        'failed',
        null,
        'permanent',
        'LEASE_EXPIRED',
        null,
        null,
        null
      );
      exhausted := exhausted + 1;
    else
      outcome := ops.record_tenant_command_attempt(
        expired.id,
        'timeout',
        null,
        'transient',
        'LEASE_EXPIRED',
        null,
        null,
        null
      );
    end if;

    if outcome ->> 'status' = 'ok' then
      reaped := reaped + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'status', 'ok',
    'reaped', reaped,
    'exhausted', exhausted,
    'skipped', skipped
  );
end;
$$;


-- 新建函数默认对 PUBLIC 有 EXECUTE，只写 GRANT 等于没拦（A1 踩过）。
REVOKE ALL ON function ops.claim_tenant_commands (text, integer, interval)
FROM
  public,
  anon,
  authenticated;

REVOKE ALL ON function ops.complete_tenant_command (
  uuid,
  text,
  text,
  integer,
  text,
  text,
  jsonb,
  text
)
FROM
  public,
  anon,
  authenticated;

REVOKE ALL ON function ops.reap_tenant_commands (interval, integer)
FROM
  public,
  anon,
  authenticated;

GRANT
EXECUTE ON function ops.claim_tenant_commands (text, integer, interval) TO service_role;

GRANT
EXECUTE ON function ops.complete_tenant_command (
  uuid,
  text,
  text,
  integer,
  text,
  text,
  jsonb,
  text
) TO service_role;

GRANT
EXECUTE ON function ops.reap_tenant_commands (interval, integer) TO service_role;
