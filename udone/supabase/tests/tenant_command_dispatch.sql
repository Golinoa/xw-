BEGIN;


SELECT
  plan (17);


-- ── 夹具 ────────────────────────────────────────────────────────────────────
-- 租约机制本身与「映射到哪个客户」无关，但 `record_tenant_command_attempt`
-- 在 `mapping_id` 为空时会报 `record "mapping_entry" is not assigned yet`
-- （既有缺陷，另案处理），所以这里挂一张最小映射绕开它。
INSERT INTO
  ops.customers (id, name, status)
VALUES
  (
    '00000000-0000-4000-8000-000000000c01',
    '租约测试客户',
    'active'
  );

INSERT INTO
  ops.products (id, code, name, lifecycle_status)
VALUES
  (
    '00000000-0000-4000-8000-000000000d01',
    'LEASE-TEST',
    '租约测试产品',
    'active'
  );

INSERT INTO
  ops.tenant_mappings (id, customer_id, product_id)
VALUES
  (
    '00000000-0000-4000-8000-000000000e01',
    '00000000-0000-4000-8000-000000000c01',
    '00000000-0000-4000-8000-000000000d01'
  );


--   t-due        到期未发 → 可被认领
--   t-future     退避中（next_retry_at 在未来）→ 不许认领
--   t-held       已被 worker-2 持有且租约未过期 → 不许抢
--   t-expired    持有但租约过期 → 回收后回 pending
--   t-exhausted  持有、租约过期、次数用尽 → 回收后落 failed/permanent
INSERT INTO
  ops.tenant_commands (
    idempotency_key,
    command_type,
    reason,
    mapping_id,
    status,
    attempt_count,
    next_retry_at,
    max_attempts,
    claimed_at,
    claimed_by,
    lease_expires_at
  )
VALUES
  (
    't-due',
    'activate',
    '契约测试夹具',
    '00000000-0000-4000-8000-000000000e01',
    'pending',
    0,
    now() - interval '1 minute',
    8,
    NULL,
    NULL,
    NULL
  ),
  (
    't-future',
    'activate',
    '契约测试夹具',
    '00000000-0000-4000-8000-000000000e01',
    'pending',
    0,
    now() + interval '1 hour',
    8,
    NULL,
    NULL,
    NULL
  ),
  (
    't-held',
    'activate',
    '契约测试夹具',
    '00000000-0000-4000-8000-000000000e01',
    'dispatching',
    1,
    NULL,
    8,
    now(),
    'worker-2',
    now() + interval '5 minutes'
  ),
  (
    't-expired',
    'activate',
    '契约测试夹具',
    '00000000-0000-4000-8000-000000000e01',
    'dispatching',
    1,
    NULL,
    8,
    now() - interval '10 minutes',
    'dead-worker',
    now() - interval '5 minutes'
  ),
  (
    't-exhausted',
    'activate',
    '契约测试夹具',
    '00000000-0000-4000-8000-000000000e01',
    'dispatching',
    7,
    NULL,
    8,
    now() - interval '10 minutes',
    'dead-worker',
    now() - interval '5 minutes'
  ),
  (
    't-nomap',
    'activate',
    '契约测试夹具',
    NULL,
    'dispatching',
    1,
    NULL,
    8,
    now() - interval '10 minutes',
    'dead-worker',
    now() - interval '5 minutes'
  );


-- ── 认领 ────────────────────────────────────────────────────────────────────
SELECT
  is(
    ops.claim_tenant_commands ('worker-1', 10, interval '5 minutes') ->> 'status',
    'ok',
    '认领返回 ok'
  );

-- 只有 t-due 满足条件：t-future 没到期、t-held 被别人持有、另两条在回收器手里。
SELECT
  is(
    ops.claim_tenant_commands ('worker-1', 10, interval '5 minutes') ->> 'count',
    '0',
    '同一批被认领过之后，再认领拿不到东西'
  );

SELECT
  is(
    (
      SELECT
        status
      FROM
        ops.tenant_commands
      WHERE
        idempotency_key = 't-due'
    ),
    'dispatching',
    '被认领的命令进入 dispatching'
  );

SELECT
  is(
    (
      SELECT
        claimed_by
      FROM
        ops.tenant_commands
      WHERE
        idempotency_key = 't-due'
    ),
    'worker-1',
    '持有人记的是真正认领它的 worker'
  );

SELECT
  isnt(
    (
      SELECT
        lease_expires_at
      FROM
        ops.tenant_commands
      WHERE
        idempotency_key = 't-due'
    ),
    NULL::timestamptz,
    '认领时写入租约（否则这条命令永远回收不了）'
  );

SELECT
  is(
    (
      SELECT
        status
      FROM
        ops.tenant_commands
      WHERE
        idempotency_key = 't-future'
    ),
    'pending',
    '退避期内的命令不被提前认领'
  );


-- ── 回收 ────────────────────────────────────────────────────────────────────
-- 一次调用同时看两个计数：分两次调会把已经回收过的再算一遍，断言就没意义了。
SELECT
  set_config(
    'lease.reap',
    ops.reap_tenant_commands (interval '0', 20)::text,
    TRUE
  );

SELECT
  is(
    current_setting('lease.reap')::jsonb ->> 'reaped',
    '2',
    '两条过期租约被回收'
  );

SELECT
  is(
    current_setting('lease.reap')::jsonb ->> 'exhausted',
    '1',
    '其中次数用尽的一条落永久失败'
  );

-- 没有 mapping 的命令会让 `record_tenant_command_attempt` 抛异常。
-- 回收是批处理，不能因为一条这样的行把整批打挂，所以它被跳过并计数。
SELECT
  is(
    current_setting('lease.reap')::jsonb ->> 'skipped',
    '1',
    '没有映射的命令被跳过并计入 skipped，不拖垮整批'
  );

SELECT
  is(
    (
      SELECT
        status
      FROM
        ops.tenant_commands
      WHERE
        idempotency_key = 't-nomap'
    ),
    'dispatching',
    '被跳过的命令保持原状，等 mapping 补齐后再回收'
  );

SELECT
  is(
    (
      SELECT
        status
      FROM
        ops.tenant_commands
      WHERE
        idempotency_key = 't-expired'
    ),
    'pending',
    '租约过期但次数未用尽 → 退回 pending 等下一次'
  );

SELECT
  isnt(
    (
      SELECT
        next_retry_at
      FROM
        ops.tenant_commands
      WHERE
        idempotency_key = 't-expired'
    ),
    NULL::timestamptz,
    '退回 pending 时排了退避时间'
  );

SELECT
  is(
    (
      SELECT
        status || '/' || coalesce(last_error_category, '-')
      FROM
        ops.tenant_commands
      WHERE
        idempotency_key = 't-exhausted'
    ),
    'failed/permanent',
    '次数用尽 → failed + permanent，不再在队列里转圈'
  );

SELECT
  is(
    (
      SELECT
        count(*)::integer
      FROM
        ops.tenant_command_attempts
      WHERE
        command_id = (
          SELECT
            id
          FROM
            ops.tenant_commands
          WHERE
            idempotency_key = 't-exhausted'
        )
    ),
    1,
    '每次回收只写一条 attempt，不重复记账'
  );

SELECT
  is(
    (
      SELECT
        status
      FROM
        ops.tenant_commands
      WHERE
        idempotency_key = 't-held'
    ),
    'dispatching',
    '租约未过期的命令不被抢'
  );


-- ── 完成：只能由租约持有人写 ─────────────────────────────────────────────────
-- 回收时排了退避（`2^attempt` 分钟），所以刚退回的那条此刻领不到——
-- 这正是「退避生效」的证据，不是坏事。
SELECT
  is(
    ops.claim_tenant_commands ('worker-3', 10, interval '5 minutes') ->> 'count',
    '0',
    '退回 pending 的命令在退避期内不会被立刻领走'
  );

SELECT
  is(
    ops.complete_tenant_command (
      (
        SELECT
          id
        FROM
          ops.tenant_commands
        WHERE
          idempotency_key = 't-held'
      ),
      'worker-4',
      'succeeded'
    ) ->> 'status',
    'lease_holder_mismatch',
    '非持有人写结果被拒（防止原 worker 回来覆盖回收器的判定）'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;
