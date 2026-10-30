BEGIN;


SELECT
  plan (57);


-- ── 夹具 ────────────────────────────────────────────────────────────────────
-- 五个 auth 用户：平台管理员、只读（`ops_viewer`）、没有运营行的租户成员、
-- 停用账号、以及一个「是运营成员但一个角色都没有」的账号。
--
-- 第五个账号是 P3 的落点。`support_agent` 也有 `customer.read`，用它证明不了
-- 「按动作码判权限」；只有拿掉全部角色才只剩这一种解释。
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-0000000000e1',
    'authenticated',
    'authenticated',
    'cust-admin@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000e2',
    'authenticated',
    'authenticated',
    'cust-viewer@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000e3',
    'authenticated',
    'authenticated',
    'cust-tenant@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000e4',
    'authenticated',
    'authenticated',
    'cust-disabled@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000e5',
    'authenticated',
    'authenticated',
    'cust-norole@example.test'
  );


INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-000000000071',
    '00000000-0000-4000-8000-0000000000e1',
    'cust-admin@example.test',
    '客户域管理员',
    'active'
  ),
  (
    '00000000-0000-4000-8000-000000000072',
    '00000000-0000-4000-8000-0000000000e2',
    'cust-viewer@example.test',
    '客户域只读',
    'active'
  ),
  (
    '00000000-0000-4000-8000-000000000073',
    '00000000-0000-4000-8000-0000000000e4',
    'cust-disabled@example.test',
    '已停用管理员',
    'disabled'
  ),
  (
    '00000000-0000-4000-8000-000000000074',
    '00000000-0000-4000-8000-0000000000e5',
    'cust-norole@example.test',
    '无角色成员',
    'active'
  );


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-000000000071',
  role.id,
  '00000000-0000-4000-8000-000000000071'
FROM
  ops.roles AS role
WHERE
  role.code = 'platform_admin';


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-000000000072',
  role.id,
  '00000000-0000-4000-8000-000000000071'
FROM
  ops.roles AS role
WHERE
  role.code = 'ops_viewer';


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-000000000073',
  role.id,
  '00000000-0000-4000-8000-000000000071'
FROM
  ops.roles AS role
WHERE
  role.code = 'platform_admin';


-- ── P1：能力面 ──────────────────────────────────────────────────────────────
-- 两张表对 authenticated 连 SELECT 都没有：读也走 RPC（掩码/原值键由 RPC 决定，
-- 表级 grant 表达不了「有键 / 没键」）。
SELECT
  ok (
    NOT has_schema_privilege('anon', 'ops', 'USAGE'),
    'P1 anon has no usage on the ops schema'
  );


SELECT
  ok (
    NOT has_table_privilege('anon', 'ops.customers', 'SELECT'),
    'P1 anon cannot select ops.customers'
  );


SELECT
  ok (
    NOT has_table_privilege('anon', 'ops.customer_contacts', 'SELECT'),
    'P1 anon cannot select ops.customer_contacts'
  );


SELECT
  ok (
    NOT has_table_privilege('authenticated', 'ops.customers', 'SELECT'),
    'P1 authenticated has no direct select on ops.customers'
  );


SELECT
  ok (
    NOT has_table_privilege('authenticated', 'ops.customers', 'INSERT'),
    'P1 authenticated cannot insert into ops.customers directly'
  );


SELECT
  ok (
    NOT has_table_privilege(
      'authenticated',
      'ops.customer_contacts',
      'INSERT'
    ),
    'P1 authenticated cannot insert into ops.customer_contacts directly'
  );


SELECT
  ok (
    NOT has_function_privilege(
      'anon',
      'ops.list_customers(text,text[],uuid,text,integer,text,text,integer,integer)',
      'EXECUTE'
    ),
    'P1 anon cannot execute list_customers'
  );


SELECT
  ok (
    NOT has_function_privilege(
      'authenticated',
      'ops.customer_contact_json(uuid,boolean)',
      'EXECUTE'
    ),
    'the contact shape helper is not callable by authenticated'
  );


SELECT
  ok (
    NOT has_function_privilege(
      'authenticated',
      'ops.customer_reference_counts(uuid)',
      'EXECUTE'
    ),
    'the reference-count helper is not callable by authenticated'
  );


-- ── P2：租户成员（没有 ops 行）─────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000e3","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    'select ops.list_customers()',
    '42501',
    NULL,
    'P2 a tenant member without an operator row cannot list customers'
  );


RESET ROLE;


-- ── P3：有效运营成员但没有 customer.read ────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000e5","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    'select ops.list_customers()',
    '42501',
    NULL,
    'P3 an operator without customer.read cannot list customers'
  );


RESET ROLE;


-- ── P4：停用账号 ────────────────────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000e4","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    'select ops.list_customers()',
    '42501',
    NULL,
    'P4 a disabled operator cannot list customers'
  );


RESET ROLE;


-- ── 只读账号写路径：动作码不够就是 42501，而不是业务信封 ────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000e2","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    $$select ops.create_customer('越权客户')$$,
    '42501',
    NULL,
    'a viewer with customer.read but not customer.write cannot create a customer'
  );


RESET ROLE;


-- ── 管理员视角：创建 ────────────────────────────────────────────────────────
-- 这一段起不再 `SET LOCAL ROLE authenticated`：RPC 都是 SECURITY DEFINER，权限
-- 判定读的是 `request.jwt.claims`（`auth.uid()`），与执行角色无关；而断言需要
-- 回读 `ops.customers` 取 id，authenticated 在本轮连 SELECT 都没有（这正是 P1）。
-- 用 JWT 声明扮演管理员，比为了取 id 再开一个读权限更能说明问题。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}',
    TRUE
  );


CREATE TEMPORARY TABLE customer_step (payload jsonb) ON
COMMIT
DROP;


DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.create_customer (p_name => '甲客户', p_reason => '新签客户');


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        customer_step
    ),
    'ok',
    'an admin creates a customer'
  );


SELECT
  matches (
    (
      SELECT
        payload #>> '{customer,customer_no}'
      FROM
        customer_step
    ),
    '^CUS-[0-9]{6}$',
    'the customer number follows the CUS-000123 shape'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{customer,status}'
      FROM
        customer_step
    ),
    'signed',
    'a new customer starts in signed'
  );


SELECT
  IS (
    (
      SELECT
        payload -> 'duplicate_hints'
      FROM
        customer_step
    ),
    '[]'::jsonb,
    'a unique customer name produces no duplicate hints'
  );


DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.create_customer (
    p_name => '乙客户',
    p_unified_social_credit_code => '91310000TEST0001X',
    p_contacts => '[{"name":"张三","job_title":"采购","phone":"13800138888","email":"zhang@example.test","is_primary":true,"usage_scene":"合同签署"}]'::jsonb,
    p_reason => '新签客户'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        customer_step
    ),
    'ok',
    'creating a customer with an embedded primary contact succeeds'
  );


DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.create_customer (p_name => '乙客户', p_reason => '同名客户，只提示不阻断');


SELECT
  IS (
    (
      SELECT
        payload #>> '{duplicate_hints,0,reason}'
      FROM
        customer_step
    ),
    'NAME_MATCH',
    'a same-name customer yields a NAME_MATCH hint'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        customer_step
    ),
    'ok',
    'a duplicate name does not block creation'
  );


SELECT
  IS (
    (
      ops.check_customer_duplicates (p_name => '乙客户') -> 'items' -> 0 ->> 'match_reason'
    ),
    'NAME_MATCH',
    'the duplicate-check endpoint reports the same match reason'
  );


-- ── 责任人不存在 ────────────────────────────────────────────────────────────
DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.create_customer (
    p_name => '孤儿责任人客户',
    p_owner_operator_id => '00000000-0000-4000-8000-0000000000ff',
    p_reason => '责任人不存在'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        customer_step
    ),
    'unknown_owner',
    'an owner that is not an operator is refused with its id'
  );


-- ── 详情与列表形状 ──────────────────────────────────────────────────────────
SELECT
  ok (
    (
      ops.get_customer (
        (
          SELECT
            id
          FROM
            ops.customers
          WHERE
            name = '甲客户'
        )
      ) -> 'counts'
    ) ?& ARRAY[
      'contracts',
      'receivables',
      'subscriptions',
      'licenses',
      'deployments',
      'tickets'
    ],
    'the customer detail carries all six count keys'
  );


SELECT
  ok (
    (ops.list_customers () -> 'items' -> 0) ?& ARRAY['primary_contact', 'active_contract_count'],
    'the list row carries primary_contact and active_contract_count'
  );


SELECT
  IS (
    ops.list_customers (p_keyword => '甲') -> 'total',
    '1'::jsonb,
    'the keyword filter matches on the customer name'
  );


SELECT
  IS (
    ops.list_customers (p_statuses => ARRAY['terminated']) -> 'total',
    '0'::jsonb,
    'the status filter excludes customers in other states'
  );


-- ── P6：无 customer.sensitive.read 时原值键不存在 ───────────────────────────
-- 这一条客户与联系人用固定 UUID 直接写入：断言发生在
-- `SET LOCAL ROLE authenticated` 之后，而该角色本轮连 `ops.customers` 的 SELECT
-- 都没有（P1），没法用子查询取 id。固定 id 也让断言里的调用读起来更直接。
INSERT INTO
  ops.customers (id, name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000000a1',
    '掩码验证客户',
    'signed'
  );


INSERT INTO
  ops.customer_contacts (id, customer_id, name, phone, email, is_primary)
VALUES
  (
    '00000000-0000-4000-8000-0000000000b1',
    '00000000-0000-4000-8000-0000000000a1',
    '张三',
    '13800138888',
    'zhang@example.test',
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000e2","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    ops.list_customer_contacts ('00000000-0000-4000-8000-0000000000a1') ->> 'status',
    'ok',
    'a viewer with customer.read can list contacts'
  );


SELECT
  ok (
    NOT (
      ops.list_customer_contacts ('00000000-0000-4000-8000-0000000000a1') -> 'items' -> 0
    ) ? 'phone',
    'P6 the contact element has no phone key without customer.sensitive.read'
  );


SELECT
  ok (
    NOT (
      ops.list_customer_contacts ('00000000-0000-4000-8000-0000000000a1') -> 'items' -> 0
    ) ? 'email',
    'P6 the contact element has no email key without customer.sensitive.read'
  );


SELECT
  ok (
    (
      ops.list_customer_contacts ('00000000-0000-4000-8000-0000000000a1') -> 'items' -> 0
    ) ? 'phone_masked',
    'P6 the masked phone key is always present'
  );


SELECT
  IS (
    (
      ops.list_customer_contacts ('00000000-0000-4000-8000-0000000000a1') -> 'items' -> 0 ->> 'phone_masked'
    ),
    '138****8888',
    'P6 the viewer still sees the masked phone'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000e1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    (
      ops.list_customer_contacts ('00000000-0000-4000-8000-0000000000a1') -> 'items' -> 0 ->> 'phone'
    ),
    '13800138888',
    'an operator with customer.sensitive.read gets the raw phone value'
  );


RESET ROLE;


-- ── 状态机 ──────────────────────────────────────────────────────────────────
DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.transition_customer (
    (
      SELECT
        id
      FROM
        ops.customers
      WHERE
        name = '甲客户'
    ),
    'start_onboarding',
    '开始交付',
    1
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        customer_step
    ),
    'contacts_required',
    'start_onboarding without a contact is refused'
  );


DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.create_customer_contact (
    (
      SELECT
        id
      FROM
        ops.customers
      WHERE
        name = '甲客户'
    ),
    p_name => '李四',
    p_phone => '13800138888',
    p_is_primary => TRUE,
    p_reason => '补录联系人'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        customer_step
    ),
    'ok',
    'a contact can be added to a signed customer'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contact,phone_masked}'
      FROM
        customer_step
    ),
    '138****8888',
    'the masked phone keeps the first three and last four digits'
  );


DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.transition_customer (
    (
      SELECT
        id
      FROM
        ops.customers
      WHERE
        name = '甲客户'
    ),
    'start_onboarding',
    '开始交付',
    1
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        customer_step
    ),
    'ok',
    'start_onboarding succeeds once a contact exists'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{customer,status}'
      FROM
        customer_step
    ),
    'onboarding',
    'start_onboarding moves signed to onboarding'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{customer,version}'
      FROM
        customer_step
    ),
    '2',
    'a transition bumps the optimistic-lock version'
  );


DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.transition_customer (
    (
      SELECT
        id
      FROM
        ops.customers
      WHERE
        name = '甲客户'
    ),
    'activate',
    '开通完成',
    2
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{customer,status}'
      FROM
        customer_step
    ),
    'active',
    'activate moves onboarding to active'
  );


DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.transition_customer (
    (
      SELECT
        id
      FROM
        ops.customers
      WHERE
        name = '甲客户'
    ),
    'suspend',
    '客户欠费',
    3
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{customer,status}'
      FROM
        customer_step
    ),
    'suspended',
    'suspend moves active to suspended'
  );


DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.transition_customer (
    (
      SELECT
        id
      FROM
        ops.customers
      WHERE
        name = '甲客户'
    ),
    'resume',
    '欠费结清',
    4
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{customer,status}'
      FROM
        customer_step
    ),
    'active',
    'resume moves suspended back to active'
  );


DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.transition_customer (
    (
      SELECT
        id
      FROM
        ops.customers
      WHERE
        name = '甲客户'
    ),
    'activate',
    '重复开通',
    5
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        customer_step
    ),
    'invalid_transition',
    'an edge that does not exist in the state machine is refused'
  );


DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.transition_customer (
    (
      SELECT
        id
      FROM
        ops.customers
      WHERE
        name = '甲客户'
    ),
    'terminate',
    '客户流失',
    5
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{customer,status}'
      FROM
        customer_step
    ),
    'terminated',
    'terminate moves an active customer to terminated'
  );


DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.transition_customer (
    (
      SELECT
        id
      FROM
        ops.customers
      WHERE
        name = '甲客户'
    ),
    'terminate',
    '再次终止',
    6
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        customer_step
    ),
    'invalid_transition',
    'terminated is a terminal state'
  );


-- ── 引用守卫：临时替身表证明 referenced 分支 ────────────────────────────────
-- 四张域表还不存在，而这条分支必须在本轮就被证明，否则「terminate 会检查引用」
-- 只是一句注释。替身表建在同一事务里，`to_regclass` 在运行期就能看见它；
-- 断言完立刻 drop，最终整个测试文件回滚，不会留下任何东西。
DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.create_customer (
    p_name => '丙客户',
    p_contacts => '[{"name":"王五","is_primary":true}]'::jsonb,
    p_reason => '引用守卫用例'
  );


CREATE TABLE ops.contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid
);


INSERT INTO
  ops.contracts (customer_id)
SELECT
  id
FROM
  ops.customers
WHERE
  name = '丙客户';


DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.transition_customer (
    (
      SELECT
        id
      FROM
        ops.customers
      WHERE
        name = '丙客户'
    ),
    'terminate',
    '客户流失',
    1
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        customer_step
    ),
    'referenced',
    'terminate is refused while an active contract references the customer'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{impact,contracts}'
      FROM
        customer_step
    ),
    '1',
    'the referenced envelope carries the impact counts'
  );


DROP TABLE ops.contracts;


-- ── 编号唯一 ────────────────────────────────────────────────────────────────
INSERT INTO
  ops.customers (customer_no, name, status)
VALUES
  ('CUS-009999', '编号样例', 'signed');


SELECT
  throws_ok (
    $$insert into ops.customers (customer_no, name, status) values ('CUS-009999', '编号样例二号', 'signed')$$,
    '23505',
    NULL,
    'the customer number is unique'
  );


-- ── 主要联系人：新主要把旧主要降级 ──────────────────────────────────────────
DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.create_customer_contact (
    (
      SELECT
        id
      FROM
        ops.customers
      WHERE
        name = '乙客户'
      ORDER BY
        customer_no
      LIMIT
        1
    ),
    p_name => '李四',
    p_is_primary => TRUE,
    p_reason => '换主要联系人'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        customer_step
    ),
    'ok',
    'a second primary contact can be created'
  );


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        ops.customer_contacts AS contact
        JOIN ops.customers AS customer ON customer.id = contact.customer_id
      WHERE
        customer.name = '乙客户'
        AND contact.is_primary
    ),
    1::bigint,
    'only one primary contact survives per customer'
  );


SELECT
  IS (
    (
      SELECT
        contact.is_primary
      FROM
        ops.customer_contacts AS contact
        JOIN ops.customers AS customer ON customer.id = contact.customer_id
      WHERE
        customer.name = '乙客户'
        AND contact.name = '张三'
    ),
    FALSE,
    'the previous primary contact is demoted'
  );


-- ── 乐观锁 ──────────────────────────────────────────────────────────────────
DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.update_customer (
    (
      SELECT
        id
      FROM
        ops.customers
      WHERE
        name = '乙客户'
      ORDER BY
        customer_no
      LIMIT
        1
    ),
    p_expected_version => 99,
    p_name => '乙客户改名',
    p_reason => '版本过期'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        customer_step
    ),
    'version_mismatch',
    'a stale version is refused'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'current_version'
      FROM
        customer_step
    ),
    '1',
    'the mismatch envelope reports the current version'
  );


-- ── 删除联系人 ──────────────────────────────────────────────────────────────
DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.create_customer (
    p_name => '丁客户',
    p_contacts => '[{"name":"赵六","is_primary":true}]'::jsonb,
    p_reason => '删除守卫用例'
  );


SELECT
  IS (
    ops.delete_customer_contact (
      (
        SELECT
          id
        FROM
          ops.customers
        WHERE
          name = '丁客户'
      ),
      (
        SELECT
          contact.id
        FROM
          ops.customer_contacts AS contact
          JOIN ops.customers AS customer ON customer.id = contact.customer_id
        WHERE
          customer.name = '丁客户'
      ),
      NULL,
      NULL
    ) ->> 'status',
    'last_primary',
    'the last contact of a non-terminated customer cannot be deleted'
  );


DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.create_customer (p_name => '戊客户', p_reason => '终态删除用例');


SELECT
  IS (
    ops.transition_customer (
      (
        SELECT
          id
        FROM
          ops.customers
        WHERE
          name = '戊客户'
      ),
      'terminate',
      '客户流失',
      1
    ) ->> 'status',
    'ok',
    'a signed customer can be terminated'
  );


DELETE FROM customer_step;


INSERT INTO
  customer_step
SELECT
  ops.create_customer_contact (
    (
      SELECT
        id
      FROM
        ops.customers
      WHERE
        name = '戊客户'
    ),
    p_name => '孙七',
    p_reason => '终态补录联系人'
  );


SELECT
  IS (
    ops.delete_customer_contact (
      (
        SELECT
          id
        FROM
          ops.customers
        WHERE
          name = '戊客户'
      ),
      (
        SELECT
          contact.id
        FROM
          ops.customer_contacts AS contact
          JOIN ops.customers AS customer ON customer.id = contact.customer_id
        WHERE
          customer.name = '戊客户'
      ),
      NULL,
      NULL
    ) ->> 'status',
    'ok',
    'a terminated customer can lose its last contact'
  );


-- ── 审计 ────────────────────────────────────────────────────────────────────
SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'customer.created'
    ),
    'customer.created is written to the audit trail'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'customer.transitioned'
    ),
    'customer.transitioned is written to the audit trail'
  );


RESET ROLE;


SELECT
  *
FROM
  finish ();


ROLLBACK;