BEGIN;


SELECT
  plan (5);


-- ── 夹具 ────────────────────────────────────────────────────────────────────
-- 这个文件要回答的问题只有一个：**总览上的数字，和明细表里的行，是不是同一批**。
-- 之前的总览断言只对常数（「等于 2」），常数是由夹具凑出来的，改了 RPC 的口径
-- 而忘了改夹具以外的东西时，测试照样绿。所以这里每个指标都再用一段独立的 SQL
-- 从底表复算一遍，两边相等才算过。
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-000000000e21',
    'authenticated',
    'authenticated',
    'overview-consistency@example.test'
  );

INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-000000000e31',
    '00000000-0000-4000-8000-000000000e21',
    'overview-consistency@example.test',
    '口径核对账号',
    'active'
  );

INSERT INTO
  ops.roles (id, code, name, is_system)
VALUES
  (
    '00000000-0000-4000-8000-000000000e41',
    'overview_consistency',
    '口径核对角色',
    false
  );

INSERT INTO
  ops.role_permissions (role_id, permission_code)
VALUES
  ('00000000-0000-4000-8000-000000000e41', 'overview.read'),
  ('00000000-0000-4000-8000-000000000e41', 'ticket.read'),
  ('00000000-0000-4000-8000-000000000e41', 'tenant.read');

INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
VALUES
  (
    '00000000-0000-4000-8000-000000000e31',
    '00000000-0000-4000-8000-000000000e41',
    '00000000-0000-4000-8000-000000000e31'
  );

INSERT INTO
  ops.customers (id, name, status)
VALUES
  (
    '00000000-0000-4000-8000-000000000e51',
    '口径核对客户',
    'active'
  );

INSERT INTO
  ops.products (id, code, name, lifecycle_status)
VALUES
  (
    '00000000-0000-4000-8000-000000000e61',
    'OVERVIEW-CONSISTENCY',
    '口径核对产品',
    'active'
  );

-- 五张工单：3 张在途（new / assigned / waiting）、1 张 resolved、1 张 closed。
INSERT INTO
  ops.tickets (
    id, customer_id, subject, description, issue_type, priority, status,
    waiting_on, closed_at
  )
VALUES
  (
    '00000000-0000-4000-8000-000000000e71',
    '00000000-0000-4000-8000-000000000e51',
    '新工单',
    '在途',
    'incident',
    'normal',
    'new',
    NULL,
    NULL
  ),
  (
    '00000000-0000-4000-8000-000000000e72',
    '00000000-0000-4000-8000-000000000e51',
    '已指派工单',
    '在途',
    'incident',
    'normal',
    'assigned',
    NULL,
    NULL
  ),
  (
    '00000000-0000-4000-8000-000000000e73',
    '00000000-0000-4000-8000-000000000e51',
    '等待客户回复',
    '在途',
    'incident',
    'normal',
    'waiting',
    'customer',
    NULL
  ),
  (
    '00000000-0000-4000-8000-000000000e74',
    '00000000-0000-4000-8000-000000000e51',
    '已解决工单',
    '终态',
    'incident',
    'normal',
    'resolved',
    NULL,
    NULL
  ),
  (
    '00000000-0000-4000-8000-000000000e75',
    '00000000-0000-4000-8000-000000000e51',
    '已关闭工单',
    '终态',
    'incident',
    'normal',
    'closed',
    NULL,
    now()
  );

-- 两个映射，专治「有失败命令的映射数」这个容易写错的口径：
--   映射 A：失败过，但**最新一条是成功** → 现在是好的，不该计入
--   映射 B：最新一条是失败 → 计入
-- 若实现写成「存在失败命令的映射数」，答案会是 2，这里会红。
INSERT INTO
  ops.tenant_mappings (id, customer_id, product_id)
VALUES
  (
    '00000000-0000-4000-8000-000000000e81',
    '00000000-0000-4000-8000-000000000e51',
    '00000000-0000-4000-8000-000000000e61'
  ),
  (
    '00000000-0000-4000-8000-000000000e82',
    '00000000-0000-4000-8000-000000000e51',
    '00000000-0000-4000-8000-000000000e61'
  );

INSERT INTO
  ops.tenant_commands (
    idempotency_key,
    command_type,
    reason,
    mapping_id,
    status,
    attempt_count,
    max_attempts,
    completed_at,
    created_at
  )
VALUES
  (
    'consistency-a-failed',
    'activate',
    '口径核对',
    '00000000-0000-4000-8000-000000000e81',
    'failed',
    1,
    8,
    now() - interval '2 hours',
    now() - interval '2 hours'
  ),
  (
    'consistency-a-succeeded',
    'activate',
    '口径核对',
    '00000000-0000-4000-8000-000000000e81',
    'succeeded',
    1,
    8,
    now() - interval '1 hour',
    now() - interval '1 hour'
  ),
  (
    'consistency-b-failed',
    'activate',
    '口径核对',
    '00000000-0000-4000-8000-000000000e82',
    'failed',
    1,
    8,
    now() - interval '30 minutes',
    now() - interval '30 minutes'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000e21","role":"authenticated"}',
    TRUE
  );


-- ── 在途工单 ────────────────────────────────────────────────────────────────
SELECT
  is(
    ops.get_ops_overview () -> 'metrics' ->> 'open_tickets',
    (
      SELECT
        count(*)::text
      FROM
        ops.tickets
      WHERE
        status NOT IN ('resolved', 'closed')
    ),
    '在途工单数与明细表同一批（不是夹具常数）'
  );


SELECT
  is(
    ops.get_ops_overview () -> 'metrics' ->> 'waiting_tickets',
    (
      SELECT
        count(*)::text
      FROM
        ops.tickets
      WHERE
        status = 'waiting'
    ),
    '等待客户回复的工单数一致'
  );


-- ── 同步失败 ────────────────────────────────────────────────────────────────
SELECT
  is(
    ops.get_ops_overview () -> 'metrics' ->> 'failed_sync_commands',
    (
      SELECT
        count(*)::text
      FROM
        (
          SELECT DISTINCT
            ON (entry.mapping_id) entry.status
          FROM
            ops.tenant_commands AS entry
          WHERE
            entry.mapping_id IS NOT NULL
          ORDER BY
            entry.mapping_id,
            entry.created_at DESC,
            entry.id
        ) AS latest
      WHERE
        latest.status = 'failed'
    ),
    '同步失败数按「每个映射的最新一条」算'
  );


-- 这一条是上一条的对照组：夹具里 2 个映射都有失败命令，
-- 但只有 1 个的**最新**一条是失败。实现若按「存在失败」数就会得到 2。
SELECT
  is(
    ops.get_ops_overview () -> 'metrics' ->> 'failed_sync_commands',
    '1',
    '失败过但已恢复的映射不计入（否则这个数字只增不减）'
  );


-- ── 权限被挡时不是 0 ─────────────────────────────────────────────────────────
-- 无权的指标必须以「不在 metrics 里、名字进 restrictedMetrics」的形式出现，
-- 而不是给一个 0 冒充。——这条锁住的是「看不清」与「真的是 0」的区别。
SELECT
  is(
    ops.get_ops_overview () -> 'metrics' ->> 'pending_receipt_amount',
    NULL,
    '没有 receivable.read 时该指标不出现（不是 0）'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;
