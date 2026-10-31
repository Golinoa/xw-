-- billing 域：把核销分配 / 撤销流水的出站形状收成一处（契约 §5.5）。
--
-- 起因是上一轮的权宜写法：`20261031000002` 里 `get_receivable` 对
-- `allocations[]` / `reversals[]` 用的是 `jsonb_agg(to_jsonb(entry))`——
-- 那是「原始行透传」，键名是表列（`receipt_id`、`reversed_by`、`allocated_by`），
-- 而同一个响应里的 `receivable` 是 camelCase。当时这么写是因为两张表还不存在，
-- 没有形状可写；现在 `20261031000004` 把它们建出来了，透传就变成一个真实的
-- 缺陷：同一个端点的两个区块，一个是 camelCase，一个是 snake_case。
--
-- 三件事：
--
-- 1. **形状各写一份就会各漂各的。** `GET /receivables/{id}` 与
--    `GET /receipts/{id}` 都要回核销分配：前者按应收过滤（「这期是谁付的」），
--    后者按收款过滤（「这笔钱抵了哪几期」）。过滤方向相反，但每一条的形状必须
--    相同——否则前端要为同一个列表写两套渲染。所以收成
--    `ops.allocation_json` / `ops.reversal_json` 两个函数，两个端点都调它。
--
-- 2. **应收侧的分配多了 `receipt_no`。** 只回 `receipt_id` 等于逼前端为每一行
--    再查一次收款，把一次详情变成 N+1（与 U-20 同一个理由）。收款侧的分配也
--    多了 `period_no` / `due_date`，同理。
--
-- 3. **不改 `20261031000004` 与 `20261031000002` 的文件。** 迁移是历史，改了
--    等于让已跑过的库与文件不一致（`db:local:verify` 会从空库重放，但下游
--    环境不会）。用 `CREATE OR REPLACE` 覆盖同一个函数，只换那两段。
CREATE OR REPLACE FUNCTION ops.allocation_json (p_allocation_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', allocation.id,
    'receipt_id', allocation.receipt_id,
    'receipt_no', receipt.receipt_no,
    'receivable_id', allocation.receivable_id,
    'period_no', receivable.period_no,
    'contract_id', receivable.contract_id,
    'due_date', receivable.due_date,
    'amount', allocation.amount,
    -- 这条分配被撤销的部分。不是「该期被撤销的部分」——一期可能被多笔收款
    -- 核销，按分配统计才能说清是哪一笔被撤了。
    'reversed_amount', coalesce((
      select sum(reversal.amount)
      from ops.receipt_allocation_reversals as reversal
      where reversal.allocation_id = allocation.id
    ), 0),
    'allocated_by', ops.operator_ref(allocation.allocated_by),
    'allocated_at', allocation.allocated_at
  )
  from ops.receipt_allocations as allocation
  join ops.receipts as receipt on receipt.id = allocation.receipt_id
  join ops.receivables as receivable on receivable.id = allocation.receivable_id
  where allocation.id = p_allocation_id;
$$;


CREATE OR REPLACE FUNCTION ops.reversal_json (p_reversal_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', reversal.id,
    'allocation_id', reversal.allocation_id,
    'receivable_id', allocation.receivable_id,
    'amount', reversal.amount,
    'reason', reversal.reason,
    'reversed_by', ops.operator_ref(reversal.reversed_by),
    'created_at', reversal.created_at
  )
  from ops.receipt_allocation_reversals as reversal
  join ops.receipt_allocations as allocation on allocation.id = reversal.allocation_id
  where reversal.id = p_reversal_id;
$$;


-- 应收详情：两个区块换成共享形状。其余部分与 `20261031000002` 逐字一致。
CREATE OR REPLACE FUNCTION ops.get_receivable (p_receivable_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  extensions jsonb := '[]'::jsonb;
  allocations jsonb := '[]'::jsonb;
  reversals jsonb := '[]'::jsonb;
begin
  perform ops.require_permission('receivable.read');

  if not exists (
    select 1 from ops.receivables as entry where entry.id = p_receivable_id
  ) then
    return jsonb_build_object('status', 'receivable_not_found');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', extension.id,
        'previous_due_date', extension.previous_due_date,
        'new_due_date', extension.new_due_date,
        'reason', extension.reason,
        'created_by', extension.created_by,
        'created_at', extension.created_at
      )
      order by extension.created_at desc, extension.id
    ),
    '[]'::jsonb
  )
  into extensions
  from ops.receivable_extensions as extension
  where extension.receivable_id = p_receivable_id;

  select coalesce(
    jsonb_agg(
      ops.allocation_json(allocation.id)
      order by allocation.allocated_at, allocation.id
    ),
    '[]'::jsonb
  )
  into allocations
  from ops.receipt_allocations as allocation
  where allocation.receivable_id = p_receivable_id;

  select coalesce(
    jsonb_agg(
      ops.reversal_json(reversal.id)
      order by reversal.created_at, reversal.id
    ),
    '[]'::jsonb
  )
  into reversals
  from ops.receipt_allocation_reversals as reversal
  join ops.receipt_allocations as allocation on allocation.id = reversal.allocation_id
  where allocation.receivable_id = p_receivable_id;

  return jsonb_build_object(
    'status', 'ok',
    'receivable', ops.receivable_json(p_receivable_id),
    'allocations', allocations,
    'extensions', extensions,
    'reversals', reversals
  );
end;
$$;


-- 收款详情：同样换成共享形状，`allocation_json` 多出来的 `receipt_no` /
-- `period_no` / `due_date` 在这里同样该有（对称）。
CREATE OR REPLACE FUNCTION ops.get_receipt (p_receipt_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  allocations jsonb := '[]'::jsonb;
  reversals jsonb := '[]'::jsonb;
  refunds jsonb := '[]'::jsonb;
begin
  perform ops.require_permission('receivable.read');

  if not exists (select 1 from ops.receipts as entry where entry.id = p_receipt_id) then
    return jsonb_build_object('status', 'receipt_not_found');
  end if;

  select coalesce(
    jsonb_agg(
      ops.allocation_json(allocation.id)
      order by allocation.allocated_at, allocation.id
    ),
    '[]'::jsonb
  )
  into allocations
  from ops.receipt_allocations as allocation
  where allocation.receipt_id = p_receipt_id;

  select coalesce(
    jsonb_agg(
      ops.reversal_json(reversal.id)
      order by reversal.created_at, reversal.id
    ),
    '[]'::jsonb
  )
  into reversals
  from ops.receipt_allocation_reversals as reversal
  join ops.receipt_allocations as allocation on allocation.id = reversal.allocation_id
  where allocation.receipt_id = p_receipt_id;

  select coalesce(
    jsonb_agg(ops.refund_json(refund.id) order by refund.refund_date, refund.refund_no),
    '[]'::jsonb
  )
  into refunds
  from ops.refunds as refund
  where refund.receipt_id = p_receipt_id;

  return jsonb_build_object(
    'status', 'ok',
    'receipt', ops.receipt_json(p_receipt_id),
    'allocations', allocations,
    'reversals', reversals,
    'refunds', refunds
  );
end;
$$;


REVOKE ALL ON function ops.allocation_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.reversal_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.get_receivable (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.get_receipt (uuid)
FROM
  public,
  anon,
  authenticated;


GRANT
EXECUTE ON function ops.get_receivable (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.get_receipt (uuid) TO authenticated,
service_role;


COMMENT ON function ops.allocation_json (uuid) IS '核销分配的统一出站形状。应收详情（按应收过滤）与收款详情（按收款过滤）共用，避免同一个列表要写两套渲染。';


COMMENT ON function ops.reversal_json (uuid) IS '撤销流水的统一出站形状，两个详情端点共用。';