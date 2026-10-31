BEGIN;


SELECT
  plan (27);


-- ── 夹具 ────────────────────────────────────────────────────────────────────
-- 三个身份：
--
--   settings-admin：platform_admin，`settings.manage` 有
--   settings-sales：sales_ops，`settings.manage` **没有**（它的动作码里有
--                   customer / contract / receivable / tenant / deployment /
--                   ticket / overview / export，唯独没有设置页）
--   settings-nobody：`ops.operators` 里没有行
--
-- 第三个身份是 `GET /dictionaries` 的那条线：契约把它开放给「任意已认证运营
-- 成员」，所以「不是运营成员」必须与「没有 settings.manage」区分开——前者是
-- 401/403，后者应当仍然能读字典。
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-000000000ab1',
    'authenticated',
    'authenticated',
    'settings-admin@example.test'
  ),
  (
    '00000000-0000-4000-8000-000000000ab2',
    'authenticated',
    'authenticated',
    'settings-sales@example.test'
  ),
  (
    '00000000-0000-4000-8000-000000000ab3',
    'authenticated',
    'authenticated',
    'settings-nobody@example.test'
  );


INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-000000000aa1',
    '00000000-0000-4000-8000-000000000ab1',
    'settings-admin@example.test',
    'settings 管理员',
    'active'
  ),
  (
    '00000000-0000-4000-8000-000000000aa2',
    '00000000-0000-4000-8000-000000000ab2',
    'settings-sales@example.test',
    'settings 商务',
    'active'
  );


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-000000000aa1'::uuid,
  role.id,
  '00000000-0000-4000-8000-000000000aa1'::uuid
FROM
  ops.roles AS role
WHERE
  role.code = 'platform_admin';


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-000000000aa2'::uuid,
  role.id,
  '00000000-0000-4000-8000-000000000aa1'::uuid
FROM
  ops.roles AS role
WHERE
  role.code = 'sales_ops';


-- ── 切到管理员身份 ─────────────────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000ab1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


-- ── S：读参数项 ────────────────────────────────────────────────────────────
SELECT
  IS (
    ops.get_ops_settings () #>> '{settings,overview_expiry_window_days}',
    '30',
    'S1 the seed row is read back as a number, not as jsonb text'
  );


SELECT
  IS (
    ops.get_ops_settings () #>> '{settings,ticket_due_hours}',
    '48',
    'S2 the ticket due window has its own default'
  );


-- 种子行的 `updated_at` 是迁移落库的时刻，`updated_by` 才是「有没有人改过」。
-- 用 `updated_at IS NULL` 断「从没改过」是错的：种子一插它就有值。前端要区分
-- 「初始值」与「张三改过」靠的正是 `updatedBy` 为空。
SELECT
  ok (
    ops.get_ops_settings () #>> '{updated_by}' IS NULL
    AND ops.get_ops_settings () #>> '{updated_at}' IS NOT NULL,
    'S3 nobody changed it yet: updatedBy is null while updatedAt carries the seed time'
  );


-- ── P：写参数项 ────────────────────────────────────────────────────────────
SELECT
  IS (
    ops.update_ops_settings (
      '{"overviewExpiryWindowDays": 45}'::jsonb,
      'req-settings-1'
    ) #>> '{settings,overview_expiry_window_days}',
    '45',
    'P1 the patch lands and the response carries the new value'
  );


SELECT
  IS (
    (
      ops.update_ops_settings ('{"ticketDueHours": 60}'::jsonb, 'req-settings-2') #>> '{updated_by,display_name}'
    ),
    'settings 管理员',
    'P2 updatedBy is the operator object, not a bare uuid (U-20)'
  );


SELECT
  IS (
    ops.update_ops_settings ('{"ticketDueHours": 721}'::jsonb, NULL) ->> 'status',
    'out_of_range',
    'P3 an out-of-range hour count is a body error, not a check violation'
  );


SELECT
  IS (
    ops.update_ops_settings ('{"ticketDueHours": 721}'::jsonb, NULL) #>> '{max}',
    '720',
    'P4 the error names the upper bound so the form can show it'
  );


SELECT
  IS (
    ops.update_ops_settings ('{"exportRetentionDays": 0}'::jsonb, NULL) ->> 'status',
    'out_of_range',
    'P5 one day is the floor for the export retention'
  );


SELECT
  IS (
    ops.update_ops_settings ('{"exportRetention": 30}'::jsonb, NULL) ->> 'status',
    'unknown_key',
    'P6 a misspelled key is rejected instead of silently ignored'
  );


SELECT
  IS (
    ops.update_ops_settings ('{}'::jsonb, NULL) ->> 'status',
    'empty_patch',
    'P7 an empty patch writes nothing and audits nothing'
  );


SELECT
  IS (
    ops.update_ops_settings ('{"overviewExpiryWindowDays": 30.5}'::jsonb, NULL) ->> 'status',
    'invalid_value',
    'P8 half a day is invalid rather than silently rounded'
  );


-- 审计必须落在「这一次改动」的范围上，而不是把三行全写进 before/after：
-- 只改了工单时限，审计里出现导出保留天数会让人以为它也动了。
--
-- 这两条要 RESET ROLE：`ops.audit_events` 是 B 类表，SELECT 策略要求
-- `audit.read`，而 `platform_admin` 并不因此就能看到全部事件——用属主身份读，
-- 验的是「审计写没写下去」，不是「谁能读审计」（后者是 o-t03b 的断言）。
RESET ROLE;


SELECT
  IS (
    (
      SELECT
        event.after_summary
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'settings.updated'
        AND event.request_id = 'req-settings-1'
    ),
    '{"overviewExpiryWindowDays": 45}'::jsonb,
    'P9 the audit summary carries only the keys that changed'
  );


SELECT
  IS (
    (
      SELECT
        event.before_summary
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'settings.updated'
        AND event.request_id = 'req-settings-1'
    ) ->> 'overviewExpiryWindowDays',
    '30',
    'P10 the audit keeps the value it replaced'
  );


SET
  local role authenticated;


-- ── D：字典 ────────────────────────────────────────────────────────────────
SELECT
  IS (
    jsonb_array_length(ops.list_dictionaries () #> '{items}'),
    2,
    'D1 the two seeded dictionaries are listed'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.list_dictionaries ('payment_methods') #> '{items,0,items}'
    ),
    5,
    'D2 filtering by code narrows the list'
  );


SELECT
  IS (
    ops.list_dictionaries ('payment_methods') #>> '{items,0,items,0,value}',
    'bank_transfer',
    'D3 items are ordered by sort_order, not by insertion or uuid'
  );


SELECT
  set_config(
    'settings.item',
    ops.create_dictionary_item (
      'payment_methods',
      'unionpay',
      '银联',
      NULL,
      'req-dict-1'
    )::text,
    TRUE
  );


SELECT
  IS (
    (
      current_setting('settings.item')::jsonb #>> '{item,sort_order}'
    )::integer,
    100,
    'D4 a new item is appended after the last one (90 + 10)'
  );


SELECT
  IS (
    ops.create_dictionary_item (
      'payment_methods',
      'unionpay',
      '银联（重复）',
      NULL,
      NULL
    ) ->> 'status',
    'duplicate_value',
    'D5 the same value twice in one dictionary is a conflict'
  );


SELECT
  IS (
    ops.create_dictionary_item ('no_such_dictionary', 'x', 'X', NULL, NULL) ->> 'status',
    'dictionary_not_found',
    'D6 an unknown dictionary code is not created on the fly'
  );


SELECT
  IS (
    ops.update_dictionary_item (
      (
        current_setting('settings.item')::jsonb #>> '{item,id}'
      )::uuid,
      '{"label": "银联云闪付"}'::jsonb,
      'req-dict-2'
    ) #>> '{item,label}',
    '银联云闪付',
    'D7 the label can be rewritten without touching the stored value'
  );


SELECT
  IS (
    ops.update_dictionary_item (
      (
        current_setting('settings.item')::jsonb #>> '{item,id}'
      )::uuid,
      '{"label": null}'::jsonb,
      NULL
    ) ->> 'status',
    'label_required',
    'D8 clearing the label is rejected instead of silently ignored'
  );


SELECT
  IS (
    ops.update_dictionary_item (
      '00000000-0000-4000-8000-000000000aff',
      '{"label": "x"}'::jsonb,
      NULL
    ) ->> 'status',
    'not_found',
    'D9 an unknown item id is a 404, not a silent no-op'
  );


-- `value` 是要落进工单与收款历史的那一列，`label` 只是文案：改文案不能改值。
-- 断言写成「按 value 找到它、它带着新 label」而不是直接读表——`authenticated`
-- 读 `ops.dictionary_items` 是 42501（G4 会单独验这一条），这里能拿到的路径
-- 只有 RPC，而那正是前端会走的路径。值若被改掉，这条会查到 null。
SELECT
  IS (
    (
      SELECT
        entry ->> 'label'
      FROM
        jsonb_array_elements(
          ops.list_dictionaries ('payment_methods') #> '{items,0,items}'
        ) AS entry
      WHERE
        entry ->> 'value' = 'unionpay'
    ),
    '银联云闪付',
    'D10 the stored value is the anchor; rewriting the label leaves it untouched'
  );


-- ── G：权限边界 ────────────────────────────────────────────────────────────
-- 商务运营没有 `settings.manage`：设置页整体进不去（读写都是）。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000ab2","role":"authenticated"}',
    TRUE
  );


SELECT
  throws_ok (
    $$ select ops.get_ops_settings () $$,
    '42501',
    NULL,
    'G1 settings.manage is required to read the settings page'
  );


-- 但字典要能读：契约把它开放给「任意已认证运营成员」。这条与 G1 成对，
-- 只测 G1 会把「设置页要管理员」和「字典也要管理员」混成同一个结论。
SELECT
  IS (
    jsonb_array_length(ops.list_dictionaries () #> '{items}'),
    2,
    'G2 a sales operator without settings.manage still reads the dictionaries'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000ab3","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    ops.list_dictionaries () ->> 'status',
    'forbidden',
    'G3 a non-member gets nothing, not an empty dictionary list'
  );


SELECT
  throws_ok (
    $$ select count(*) from ops.dictionary_items $$,
    '42501',
    NULL,
    'G4 the dictionary tables are not readable through the Data API'
  );


ROLLBACK;