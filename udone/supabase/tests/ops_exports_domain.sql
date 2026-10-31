BEGIN;


SELECT
  plan (40);


-- ── 夹具 ────────────────────────────────────────────────────────────────────
-- 三个身份，每个都在验一条不同的边界：
--
--   exports-admin：platform_admin，导出全部动作码都有
--   exports-sales：sales_ops —— **有 `export.create`、没有 `export.read`**
--                  （契约 §4 的预置映射就是这样，见协作项 C-124）。它同时
--                  证明「发起」与「查看」是两条独立的门。
--   exports-reader：自建角色，**只有 `export.read`**。用来验「能看见任务、
--                  但拿不到下载」（`can_download=false`）。
--
-- ── 一处必须写下来的测试技巧 ──────────────────────────────────────────────
-- A2 表对 `authenticated` 是零直读的（G1 就是在断这件事）。所以下面所有
-- 「取某条导出的 id」都只能经 `ops.list_exports`，不能 `select id from
-- ops.exports`——后者会被 42501 挡住，而那不是测试写错了，是权限模型在生效。
-- 定位靠 `export_no` 而不是 `created_at`：同一事务里 `now()` 是恒定的，
-- 按时间排序在多行之间没有确定顺序。
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-000000000cd1',
    'authenticated',
    'authenticated',
    'exports-admin@example.test'
  ),
  (
    '00000000-0000-4000-8000-000000000cd2',
    'authenticated',
    'authenticated',
    'exports-sales@example.test'
  ),
  (
    '00000000-0000-4000-8000-000000000cd3',
    'authenticated',
    'authenticated',
    'exports-reader@example.test'
  );


INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-000000000cc1',
    '00000000-0000-4000-8000-000000000cd1',
    'exports-admin@example.test',
    'exports 管理员',
    'active'
  ),
  (
    '00000000-0000-4000-8000-000000000cc2',
    '00000000-0000-4000-8000-000000000cd2',
    'exports-sales@example.test',
    'exports 商务',
    'active'
  ),
  (
    '00000000-0000-4000-8000-000000000cc3',
    '00000000-0000-4000-8000-000000000cd3',
    'exports-reader@example.test',
    'exports 只读',
    'active'
  );


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-000000000cc1'::uuid,
  role.id,
  '00000000-0000-4000-8000-000000000cc1'::uuid
FROM
  ops.roles AS role
WHERE
  role.code = 'platform_admin';


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-000000000cc2'::uuid,
  role.id,
  '00000000-0000-4000-8000-000000000cc1'::uuid
FROM
  ops.roles AS role
WHERE
  role.code = 'sales_ops';


INSERT INTO
  ops.roles (id, code, name, description, is_system)
VALUES
  (
    '00000000-0000-4000-8000-000000000ce1',
    'exports_reader',
    '导出只读',
    '只有 export.read：能看任务，不能发起，也不代表能拿数据',
    FALSE
  );


INSERT INTO
  ops.role_permissions (role_id, permission_code)
VALUES
  (
    '00000000-0000-4000-8000-000000000ce1',
    'export.read'
  );


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
VALUES
  (
    '00000000-0000-4000-8000-000000000cc3',
    '00000000-0000-4000-8000-000000000ce1',
    '00000000-0000-4000-8000-000000000cc1'
  );


-- 两份客户数据：导出与列表必须数出同一个数（F3）。写两行而不是一行，是因为
-- 「行数对不上」这类缺陷在一行的时候看不出来。
INSERT INTO
  ops.customers (
    id,
    name,
    status,
    owner_operator_id,
    created_by,
    updated_by
  )
VALUES
  (
    '00000000-0000-4000-8000-000000000cf1',
    '导出测试客户甲',
    'signed',
    '00000000-0000-4000-8000-000000000cc1',
    '00000000-0000-4000-8000-000000000cc1',
    '00000000-0000-4000-8000-000000000cc1'
  ),
  (
    '00000000-0000-4000-8000-000000000cf2',
    '导出测试客户乙',
    'signed',
    '00000000-0000-4000-8000-000000000cc1',
    '00000000-0000-4000-8000-000000000cc1',
    '00000000-0000-4000-8000-000000000cc1'
  );


-- ── 切到管理员身份 ─────────────────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000cd1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


-- ── C：发起 ────────────────────────────────────────────────────────────────
SELECT
  IS (
    ops.create_export (
      'customers',
      '{}'::jsonb,
      '月度客户盘点',
      'req-exports-1'
    ) ->> 'status',
    'ok',
    'C1 a valid request creates the job and answers ok'
  );


-- 单号是给人看的：`EXP-000001` 能被口头念、能被搜到。忘了它长什么样，
-- 「这份文件是哪次导出的」就只能靠时间猜。
SELECT
  matches (
    ops.create_export ('tickets', '{}'::jsonb, '工单抽检', 'req-exports-2') #>> '{export,export_no}',
    '^EXP-[0-9]{6}$',
    'C2 the export number has a stable, quoteable shape'
  );


SELECT
  IS (
    ops.list_exports (NULL, ARRAY['queued'], NULL) #>> '{items,0,status}',
    'queued',
    'C3 a freshly created job is queued, not running and not succeeded'
  );


SELECT
  IS (
    ops.create_export ('customers', '{}'::jsonb, NULL, NULL) ->> 'status',
    'reason_required',
    'C4 export.create is high risk: no reason means no export (U-17)'
  );


-- 一个空格不算理由。它会让审计里的 `reason` 看起来「有值」，从而躲过
-- 「这次导出没说为什么」的追问——这正是必填要想拦住的那件事。
SELECT
  IS (
    ops.create_export ('customers', '{}'::jsonb, '   ', NULL) ->> 'status',
    'reason_required',
    'C5 whitespace is not a reason'
  );


SELECT
  IS (
    ops.create_export ('invoices', '{}'::jsonb, '试一下没做过的类型', NULL) ->> 'status',
    'unsupported_type',
    'C6 an unknown export type is refused instead of creating an empty job'
  );


-- `filters` 是 jsonb，传数组也「合法」，但它到不了列表函数的参数映射，
-- 会在执行期变成一堆 null 筛选——那等于静默导出了全量。
SELECT
  IS (
    ops.create_export ('customers', '[]'::jsonb, '数组筛选', NULL) ->> 'status',
    'invalid_filters',
    'C7 filters must be an object, not an array'
  );


RESET ROLE;


-- 审计要能回答两个问题：这份文件是什么范围、谁要的。`reason` 在 reason 列，
-- 范围在 after 摘要里。这里读 `ops.exports` 是为了拿第一条的 id：审计只按
-- entity_id 关联，没有别的定位方式，而这是超级用户身份（RESET ROLE 之后）。
SELECT
  ok (
    (
      SELECT
        audit.after_summary ? 'filters'
        AND audit.after_summary ? 'exportNo'
        AND audit.reason = '月度客户盘点'
      FROM
        ops.audit_events AS audit
      WHERE
        audit.action = 'export.created'
        AND audit.entity_type = 'export'
        AND audit.entity_id = (
          SELECT
            entry.id
          FROM
            ops.exports AS entry
          ORDER BY
            entry.export_no
          LIMIT
            1
        )
    ),
    'C8 export.created carries the filters, the export number and the reason'
  );


-- ── R：发起与查看是两条门 ──────────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000cd2","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    ops.create_export (
      'customers',
      '{}'::jsonb,
      '商务自己导一份',
      'req-exports-3'
    ) ->> 'status',
    'ok',
    'R1 sales_ops can create an export (export.create is in its grant list)'
  );


-- 契约 §4 给 sales_ops 的是 export.create 而**没有** export.read。这条断言
-- 记录的是现状而不是期望：两个动作码本来就该分开（「能发起」不等于「能翻别人
-- 的导出记录」），但「自己发起的也看不到」显然是缺口，已记 C-124。
SELECT
  throws_ok (
    'SELECT ops.list_exports(NULL, NULL, NULL)',
    '42501',
    'ops permission denied: export.read',
    'R2 sales_ops cannot list exports: export.read is a separate code'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000cd1","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    jsonb_typeof(ops.list_exports (NULL, NULL, NULL) -> 'items'),
    'array',
    'R3 the list answers an array even when filters match nothing'
  );


-- 断「每一条都带对象形状的 requestedBy」而不是「第一条是谁」：同一事务里
-- `now()` 恒定，`ORDER BY created_at` 在多行之间没有确定顺序，按第一条断言
-- 会变成时灵时不灵——而那种绿比红更糟。
SELECT
  ok (
    (
      SELECT
        bool_and(
          jsonb_typeof(item -> 'requested_by') = 'object'
          AND item #>> '{requested_by,display_name}' IS NOT NULL
        )
      FROM
        jsonb_array_elements(ops.list_exports (NULL, NULL, NULL) -> 'items') AS item
    ),
    'R4 requestedBy is {id,displayName} on every row, not a bare uuid (U-20)'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.list_exports ('tickets', NULL, NULL) -> 'items'
    ),
    1,
    'R5 exportType narrows the list'
  );


SELECT
  ok (
    (
      SELECT
        bool_and(item ->> 'status' = 'queued')
      FROM
        jsonb_array_elements(
          ops.list_exports (NULL, ARRAY['queued'], NULL) -> 'items'
        ) AS item
    ),
    'R6 status[] narrows the list and every returned row is queued'
  );


SELECT
  IS (
    ops.get_export ('00000000-0000-4000-8000-000000000000') ->> 'status',
    'not_found',
    'R7 an unknown export id is a normal answer, not an error'
  );


SELECT
  IS (
    ops.get_export (
      (
        SELECT
          (item ->> 'id')::uuid
        FROM
          jsonb_array_elements(
            ops.list_exports ('customers', NULL, NULL) -> 'items'
          ) AS item
        ORDER BY
          item ->> 'export_no'
        LIMIT
          1
      )
    ) ->> 'can_download',
    'true',
    'R8 an admin who can read customers gets can_download=true'
  );


-- ── D：下载权按「当前请求者的域权限」判 ────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000cd3","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    ops.get_export (
      (
        SELECT
          (item ->> 'id')::uuid
        FROM
          jsonb_array_elements(
            ops.list_exports ('tickets', NULL, NULL) -> 'items'
          ) AS item
        ORDER BY
          item ->> 'export_no'
        LIMIT
          1
      )
    ) ->> 'status',
    'ok',
    'D1 a reader with only export.read still sees the job (the list gate is export.read)'
  );


-- 这条是整域的核心：有 `export.read` 不等于有 `ticket.read`。若这里给 true，
-- 一个只读导出记录的人就能拿到工单全表——`ticket.read` 这道门等于不存在。
SELECT
  IS (
    ops.get_export (
      (
        SELECT
          (item ->> 'id')::uuid
        FROM
          jsonb_array_elements(
            ops.list_exports ('tickets', NULL, NULL) -> 'items'
          ) AS item
        ORDER BY
          item ->> 'export_no'
        LIMIT
          1
      )
    ) ->> 'can_download',
    'false',
    'D2 seeing the job does not grant the data: can_download follows ticket.read'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000cd1","role":"authenticated"}',
    TRUE
  );


-- ── A：认领 ────────────────────────────────────────────────────────────────
SELECT
  IS (
    ops.claim_export () #>> '{export,status}',
    'running',
    'A1 claiming hands back a job already moved to running'
  );


-- 租约借用 `expires_at`：运行中的这一列不是产物过期时间，而是「多久没人管就
-- 放回队列」。没有它，一次进程重启会让那一行永远 running。
SELECT
  ok (
    (
      SELECT
        (item #>> '{expires_at}')::timestamptz > now() + interval '5 minutes'
      FROM
        jsonb_array_elements(
          ops.list_exports (NULL, ARRAY['running'], NULL) -> 'items'
        ) AS item
      ORDER BY
        item ->> 'export_no'
      LIMIT
        1
    ),
    'A2 the claim writes a lease, so a crashed runner cannot leave a job stuck'
  );


SELECT
  IS (
    ops.claim_export () #>> '{export,export_type}',
    'tickets',
    'A3 the second claim takes the next queued job, not the same one again'
  );


SELECT
  IS (
    ops.claim_export () #>> '{export,export_type}',
    'customers',
    'A4 the third claim takes the job sales_ops created'
  );


SELECT
  IS (
    ops.claim_export () ->> 'status',
    'empty',
    'A5 nothing left to claim answers empty instead of raising'
  );


-- ── F：取数 ────────────────────────────────────────────────────────────────
-- 新建一条 queued 的 customers 导出，用它验「没认领就不能取数」。
DO $$
BEGIN
  PERFORM ops.create_export('customers', '{}'::jsonb, '取数前先认领', 'req-exports-4');
END
$$;


SELECT
  IS (
    ops.export_fetch_rows (
      (
        SELECT
          (item ->> 'id')::uuid
        FROM
          jsonb_array_elements(
            ops.list_exports (NULL, ARRAY['queued'], NULL) -> 'items'
          ) AS item
        ORDER BY
          item ->> 'export_no'
        LIMIT
          1
      )
    ) ->> 'status',
    'not_running',
    'F1 a queued job cannot be fetched: running is the only state that may produce a file'
  );


-- 客户导出是最早认领的那一条（running）。
SELECT
  IS (
    ops.export_fetch_rows (
      (
        SELECT
          (item ->> 'id')::uuid
        FROM
          jsonb_array_elements(
            ops.list_exports ('customers', ARRAY['running'], NULL) -> 'items'
          ) AS item
        ORDER BY
          item ->> 'export_no'
        LIMIT
          1
      )
    ) #>> '{row_count}',
    '2',
    'F2 the export counts exactly the rows the customer list would show'
  );


-- 这一条是「导出与列表口径一致」的机械保证：同一份筛选，列表的 total 与
-- 导出的 row_count 必须相等。两者分叉过一次就再也对不上，而错法是
-- 「导出比列表少两行」这种没人会立刻发现的样子。
SELECT
  IS (
    (
      ops.export_fetch_rows (
        (
          SELECT
            (item ->> 'id')::uuid
          FROM
            jsonb_array_elements(
              ops.list_exports ('customers', ARRAY['running'], NULL) -> 'items'
            ) AS item
          ORDER BY
            item ->> 'export_no'
          LIMIT
            1
        )
      ) #>> '{row_count}'
    )::integer,
    (
      ops.list_customers (
        '导出测试',
        NULL,
        NULL,
        NULL,
        NULL,
        'created_at',
        'desc',
        1,
        20
      ) ->> 'total'
    )::integer,
    'F3 export row_count equals the list total for the same filter'
  );


RESET ROLE;


-- 把工单导出的发起人换成「只有 export.read」的那个人，模拟「发起人被撤权之后
-- 才轮到执行」。不去动 sales_ops 的角色权限：那会连带影响别的断言，而这里要验
-- 的只是「按 requested_by 判」这一条。
UPDATE ops.exports
SET
  requested_by = '00000000-0000-4000-8000-000000000cc3'
WHERE
  export_type = 'tickets';


SET
  local role authenticated;


SELECT
  IS (
    ops.export_fetch_rows (
      (
        SELECT
          (item ->> 'id')::uuid
        FROM
          jsonb_array_elements(
            ops.list_exports ('tickets', ARRAY['running'], NULL) -> 'items'
          ) AS item
        ORDER BY
          item ->> 'export_no'
        LIMIT
          1
      )
    ) ->> 'status',
    'forbidden',
    'F4 the data is fetched as the requester, so losing ticket.read blocks the run'
  );


-- ── S：收尾 ────────────────────────────────────────────────────────────────
SELECT
  IS (
    ops.finish_export (
      (
        SELECT
          (item ->> 'id')::uuid
        FROM
          jsonb_array_elements(
            ops.list_exports ('customers', ARRAY['running'], NULL) -> 'items'
          ) AS item
        ORDER BY
          item ->> 'export_no'
        LIMIT
          1
      ),
      2,
      'exports/probe.csv',
      'req-exports-5'
    ) #>> '{export,status}',
    'succeeded',
    'S1 finishing moves the job to succeeded'
  );


SELECT
  ok (
    (
      -- 路径用一个与单号无关的固定值：序列不随事务回滚，同一个文件跑第二遍
      -- 单号就往后走了，任何「硬编码 EXP-000001」或「与 export_no 拼」的写法
      -- 都会在第二遍之后红——这条断言要验的是「路径落库了」，不是命名规则。
      SELECT
        (item #>> '{row_count}')::integer = 2
        AND item #>> '{storage_path}' = 'exports/probe.csv'
        AND item #>> '{completed_at}' IS NOT NULL
        AND (item #>> '{expires_at}')::timestamptz > now()
      FROM
        jsonb_array_elements(
          ops.list_exports (NULL, ARRAY['succeeded'], NULL) -> 'items'
        ) AS item
      ORDER BY
        item ->> 'export_no'
      LIMIT
        1
    ),
    'S2 a succeeded job carries row_count, the object path and an expiry in the future'
  );


-- 保留期来自 `settings.retention.exportDays`（种子里是 90），由库自己算。
-- 让调用方传过期时间，等于把「保留多久」交给每次调用的心情。
SELECT
  IS (
    (
      SELECT
        (
          extract(
            epoch
            FROM
              (
                (item #>> '{expires_at}')::timestamptz - (item #>> '{completed_at}')::timestamptz
              )
          ) / 86400
        )::numeric(10, 3)::text
      FROM
        jsonb_array_elements(
          ops.list_exports (NULL, ARRAY['succeeded'], NULL) -> 'items'
        ) AS item
      ORDER BY
        item ->> 'export_no'
      LIMIT
        1
    ),
    '90.000',
    'S3 the expiry comes from settings.retention.exportDays, not from the caller'
  );


SELECT
  IS (
    ops.finish_export (
      (
        SELECT
          (item ->> 'id')::uuid
        FROM
          jsonb_array_elements(
            ops.list_exports (NULL, ARRAY['succeeded'], NULL) -> 'items'
          ) AS item
        ORDER BY
          item ->> 'export_no'
        LIMIT
          1
      ),
      99,
      'exports/EXP-999999.csv',
      NULL
    ) ->> 'status',
    'not_running',
    'S4 finishing twice does not overwrite the first result'
  );


RESET ROLE;


-- T-13 的硬要求：导出审计含 `filters` 与 `rowCount`。两者不可能同时出现在
-- 创建那一刻（还不知道行数），所以只有完成时的这一条能满足它。
SELECT
  ok (
    (
      SELECT
        audit.after_summary ? 'filters'
        AND audit.after_summary -> 'rowCount' = '2'::jsonb
      FROM
        ops.audit_events AS audit
      WHERE
        audit.action = 'export.completed'
      ORDER BY
        audit.created_at DESC
      LIMIT
        1
    ),
    'S5 export.completed carries both filters and rowCount (T-13)'
  );


SET
  local role authenticated;


-- ── B：失败 ────────────────────────────────────────────────────────────────
SELECT
  IS (
    ops.abort_export (
      (
        SELECT
          (item ->> 'id')::uuid
        FROM
          jsonb_array_elements(
            ops.list_exports (NULL, ARRAY['running'], NULL) -> 'items'
          ) AS item
        ORDER BY
          item ->> 'export_no'
        LIMIT
          1
      ),
      'REQUESTER_LOST_PERMISSION',
      'req-exports-6'
    ) ->> 'status',
    'ok',
    'B1 aborting a running job answers ok'
  );


SELECT
  ok (
    (
      SELECT
        (item #>> '{row_count}') IS NULL
        AND (item #>> '{storage_path}') IS NULL
      FROM
        jsonb_array_elements(
          ops.list_exports (NULL, ARRAY['failed'], NULL) -> 'items'
        ) AS item
      LIMIT
        1
    ),
    'B2 a failed job has no row_count and no object path: it did not produce a file'
  );


SELECT
  IS (
    ops.finish_export (
      (
        SELECT
          (item ->> 'id')::uuid
        FROM
          jsonb_array_elements(
            ops.list_exports (NULL, ARRAY['failed'], NULL) -> 'items'
          ) AS item
        LIMIT
          1
      ),
      1,
      'exports/EXP-000002.csv',
      NULL
    ) ->> 'status',
    'not_running',
    'B3 a failed job cannot be flipped to succeeded afterwards'
  );


RESET ROLE;


-- 状态与产物必须同生共死：`succeeded` 而没有对象路径的行，会让前端渲染出
-- 一个点不开的下载按钮，而真正的问题（上传没跑）被状态字段盖住。
SELECT
  throws_ok (
    'INSERT INTO ops.exports (export_type, status, requested_by, row_count) VALUES (''customers'', ''succeeded'', ''00000000-0000-4000-8000-000000000cc1'', 0)',
    '23514',
    NULL,
    'B4 succeeded without an object path is rejected by the table'
  );


-- ── X：过期 ────────────────────────────────────────────────────────────────
UPDATE ops.exports
SET
  expires_at = now() - interval '1 day'
WHERE
  status = 'succeeded';


SET
  local role authenticated;


DO $$
BEGIN
  PERFORM ops.expire_exports();
END
$$;


SELECT
  IS (
    (
      SELECT
        item ->> 'status'
      FROM
        jsonb_array_elements(
          ops.list_exports (NULL, ARRAY['expired'], NULL) -> 'items'
        ) AS item
      WHERE
        (item #>> '{row_count}')::integer = 2
      LIMIT
        1
    ),
    'expired',
    'X1 a passed retention window turns the job into expired'
  );


-- `expired` 不是「删掉了」：产物还在存储里，但状态必须先把下载口关掉。
SELECT
  ok (
    (
      SELECT
        (item #>> '{expires_at}')::timestamptz IS NOT NULL
      FROM
        jsonb_array_elements(
          ops.list_exports (NULL, ARRAY['expired'], NULL) -> 'items'
        ) AS item
      LIMIT
        1
    ),
    'X2 an expired job keeps its expiry so the page can say when it went away'
  );


RESET ROLE;


-- ── G：授权 ────────────────────────────────────────────────────────────────
-- A2 表：零直读。`authenticated` 拿不到 `ops.exports` 的 SELECT——否则
-- `export.read` 这道门可以用一条 `select * from ops.exports` 绕过去。
SELECT
  ok (
    NOT has_table_privilege('authenticated', 'ops.exports', 'SELECT'),
    'G1 authenticated has no direct read on ops.exports (A2: RPC only)'
  );


SELECT
  ok (
    NOT has_function_privilege(
      'anon',
      'ops.create_export(text, jsonb, text, text)',
      'EXECUTE'
    ),
    'G2 anon cannot execute the export RPCs'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;