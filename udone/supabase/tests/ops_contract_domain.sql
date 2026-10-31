BEGIN;


SELECT
  plan (148);


-- ── 夹具 ────────────────────────────────────────────────────────────────────
-- 六个 auth 用户：平台管理员（读写+审批）、商务（读写、不能审批）、
-- 只读、停用管理员、没有运营行的租户成员、有运营行但一个角色都没有的成员。
--
-- 商务 + 管理员这一对是「职责分离」的必要条件：变更单由商务发起、管理员批准，
-- 才能既证明 approved_by <> requested_by 能被满足，又证明同一人自批会被拒。
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-0000000000b1',
    'authenticated',
    'authenticated',
    'contract-admin@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000b2',
    'authenticated',
    'authenticated',
    'contract-writer@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000b3',
    'authenticated',
    'authenticated',
    'contract-viewer@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000b4',
    'authenticated',
    'authenticated',
    'contract-disabled@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000b5',
    'authenticated',
    'authenticated',
    'contract-tenant@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000b6',
    'authenticated',
    'authenticated',
    'contract-norole@example.test'
  );


INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000000a1',
    '00000000-0000-4000-8000-0000000000b1',
    'contract-admin@example.test',
    '合同域管理员',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000000a2',
    '00000000-0000-4000-8000-0000000000b2',
    'contract-writer@example.test',
    '合同域商务',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000000a3',
    '00000000-0000-4000-8000-0000000000b3',
    'contract-viewer@example.test',
    '合同域只读',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000000a4',
    '00000000-0000-4000-8000-0000000000b4',
    'contract-disabled@example.test',
    '已停用管理员',
    'disabled'
  ),
  (
    '00000000-0000-4000-8000-0000000000a5',
    '00000000-0000-4000-8000-0000000000b6',
    'contract-norole@example.test',
    '无角色成员',
    'active'
  );


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-0000000000a1',
  role.id,
  '00000000-0000-4000-8000-0000000000a1'
FROM
  ops.roles AS role
WHERE
  role.code = 'platform_admin';


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-0000000000a2',
  role.id,
  '00000000-0000-4000-8000-0000000000a1'
FROM
  ops.roles AS role
WHERE
  role.code = 'sales_ops';


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-0000000000a3',
  role.id,
  '00000000-0000-4000-8000-0000000000a1'
FROM
  ops.roles AS role
WHERE
  role.code = 'ops_viewer';


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-0000000000a4',
  role.id,
  '00000000-0000-4000-8000-0000000000a1'
FROM
  ops.roles AS role
WHERE
  role.code = 'platform_admin';


-- 客户与目录夹具直接写表：测试以超级用户执行，RLS 不拦属主；这一段的目的是
-- 让合同域有可引用对象，不是在测客户域/目录域的写路径。
INSERT INTO
  ops.customers (id, name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000000c1',
    '合同域活跃客户',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000000c2',
    '合同域暂停客户',
    'suspended'
  );


INSERT INTO
  ops.products (id, code, name, lifecycle_status)
VALUES
  (
    '00000000-0000-4000-8000-0000000000d1',
    'CT-SAAS',
    '合同测试产品',
    'active'
  );


INSERT INTO
  ops.product_sales_modes (product_id, sales_mode, is_enabled)
VALUES
  (
    '00000000-0000-4000-8000-0000000000d1',
    'saas',
    TRUE
  ),
  (
    '00000000-0000-4000-8000-0000000000d1',
    'private',
    FALSE
  );


INSERT INTO
  ops.packages (
    id,
    product_id,
    internal_name,
    customer_name,
    sales_mode,
    billing_type,
    default_term_months,
    currency,
    list_price,
    status
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000000e1',
    '00000000-0000-4000-8000-0000000000d1',
    'CT-PRO',
    '专业版',
    'saas',
    'periodic',
    12,
    'CNY',
    1200,
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000000e2',
    '00000000-0000-4000-8000-0000000000d1',
    'CT-DRAFT',
    '草稿版',
    'saas',
    'periodic',
    24,
    'CNY',
    800,
    'draft'
  );


INSERT INTO
  ops.package_price_versions (
    id,
    package_id,
    version_no,
    price,
    currency,
    term_months,
    effective_from
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000000f1',
    '00000000-0000-4000-8000-0000000000e1',
    1,
    1200,
    'CNY',
    12,
    '2026-01-01'
  ),
  (
    '00000000-0000-4000-8000-0000000000f2',
    '00000000-0000-4000-8000-0000000000e2',
    1,
    800,
    'CNY',
    24,
    '2026-01-01'
  );


INSERT INTO
  ops.feature_definitions (feature_key, display_name, value_type)
VALUES
  ('seats', '坐席数', 'quota'),
  ('api', 'API 访问', 'boolean');


INSERT INTO
  ops.package_features (
    package_id,
    feature_key,
    enabled,
    quota_value,
    term_months,
    applies_to
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000000e1',
    'seats',
    TRUE,
    20,
    12,
    'saas_tenant'
  ),
  (
    '00000000-0000-4000-8000-0000000000e1',
    'api',
    TRUE,
    NULL,
    NULL,
    'both'
  ),
  (
    '00000000-0000-4000-8000-0000000000e2',
    'seats',
    FALSE,
    50,
    24,
    'private_instance'
  );


-- ── P1：能力面 ──────────────────────────────────────────────────────────────
SELECT
  ok (
    NOT has_schema_privilege('anon', 'ops', 'USAGE'),
    'P1 anon has no usage on the ops schema'
  );


SELECT
  ok (
    NOT has_table_privilege('anon', 'ops.contracts', 'SELECT'),
    'P1 anon cannot select ops.contracts'
  );


SELECT
  ok (
    NOT has_table_privilege('authenticated', 'ops.contracts', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'ops.contracts', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'ops.contracts', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'ops.contracts', 'DELETE'),
    'P1 authenticated has no direct access to ops.contracts'
  );


SELECT
  ok (
    NOT has_table_privilege('authenticated', 'ops.contract_items', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'ops.contract_items', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'ops.contract_items', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'ops.contract_items', 'DELETE'),
    'P1 authenticated has no direct access to ops.contract_items'
  );


SELECT
  ok (
    NOT has_table_privilege(
      'authenticated',
      'ops.contract_versions',
      'SELECT'
    )
    AND NOT has_table_privilege(
      'authenticated',
      'ops.contract_versions',
      'INSERT'
    )
    AND NOT has_table_privilege(
      'authenticated',
      'ops.contract_versions',
      'UPDATE'
    )
    AND NOT has_table_privilege(
      'authenticated',
      'ops.contract_versions',
      'DELETE'
    ),
    'P1 authenticated has no direct access to ops.contract_versions'
  );


SELECT
  ok (
    NOT has_table_privilege(
      'authenticated',
      'ops.contract_amendments',
      'SELECT'
    )
    AND NOT has_table_privilege(
      'authenticated',
      'ops.contract_amendments',
      'INSERT'
    )
    AND NOT has_table_privilege(
      'authenticated',
      'ops.contract_amendments',
      'UPDATE'
    )
    AND NOT has_table_privilege(
      'authenticated',
      'ops.contract_amendments',
      'DELETE'
    ),
    'P1 authenticated has no direct access to ops.contract_amendments'
  );


SELECT
  ok (
    NOT has_table_privilege(
      'authenticated',
      'ops.contract_attachments',
      'SELECT'
    )
    AND NOT has_table_privilege(
      'authenticated',
      'ops.contract_attachments',
      'INSERT'
    )
    AND NOT has_table_privilege(
      'authenticated',
      'ops.contract_attachments',
      'UPDATE'
    )
    AND NOT has_table_privilege(
      'authenticated',
      'ops.contract_attachments',
      'DELETE'
    ),
    'P1 authenticated has no direct access to ops.contract_attachments'
  );


SELECT
  ok (
    NOT has_function_privilege(
      'authenticated',
      'ops.contract_json(uuid)',
      'EXECUTE'
    ),
    'the contract shape helper is not callable by authenticated'
  );


SELECT
  ok (
    NOT has_function_privilege(
      'authenticated',
      'ops.contract_version_json(uuid)',
      'EXECUTE'
    ),
    'the version shape helper is not callable by authenticated'
  );


SELECT
  ok (
    NOT has_function_privilege(
      'authenticated',
      'ops.attachment_json(uuid)',
      'EXECUTE'
    ),
    'the attachment shape helper is not callable by authenticated'
  );


SELECT
  ok (
    NOT has_function_privilege(
      'authenticated',
      'ops.contract_reference_counts(uuid)',
      'EXECUTE'
    ),
    'the reference-count helper is not callable by authenticated'
  );


SELECT
  ok (
    NOT has_function_privilege(
      'anon',
      'ops.list_contracts(text,uuid,text[],uuid,date,date,text,integer,integer)',
      'EXECUTE'
    ),
    'P1 anon cannot execute list_contracts'
  );


SELECT
  ok (
    (
      SELECT
        bool_and(class.relrowsecurity)
      FROM
        pg_class AS class
        JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
      WHERE
        namespace.nspname = 'ops'
        AND class.relname IN (
          'contracts',
          'contract_items',
          'contract_versions',
          'contract_amendments',
          'contract_attachments'
        )
    ),
    'row level security is enabled on all five contract tables'
  );


-- 合同版本只 INSERT：没有 UPDATE/DELETE 的 RPC，authenticated 连表级写权限都没有。
SELECT
  ok (
    NOT EXISTS (
      SELECT
        1
      FROM
        pg_proc AS procedure
        JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE
        namespace.nspname = 'ops'
        AND procedure.proname IN (
          'update_contract_version',
          'delete_contract_version'
        )
    ),
    'price-style insert-only: no update/delete RPC exists for contract versions'
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    'update ops.contract_versions set snapshot = ''{}''::jsonb',
    '42501',
    NULL,
    'contract versions are insert-only: UPDATE is denied'
  );


SELECT
  throws_ok (
    'delete from ops.contract_versions',
    '42501',
    NULL,
    'contract versions are insert-only: DELETE is denied'
  );


RESET ROLE;


-- ── P2：租户成员（没有 ops 行）─────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000b5","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    'select count(*) from ops.contracts',
    '42501',
    NULL,
    'P2 a tenant member cannot read ops.contracts directly'
  );


SELECT
  throws_ok (
    'select ops.list_contracts()',
    '42501',
    NULL,
    'P2 a tenant member without an operator row cannot list contracts'
  );


RESET ROLE;


-- ── P3：只读账号没有写权限；商务没有审批权限 ────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000b3","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    $$select ops.create_contract('00000000-0000-4000-8000-0000000000c1', 'saas')$$,
    '42501',
    NULL,
    'P3 a viewer with contract.read but not contract.write cannot create a contract'
  );


SELECT
  throws_ok (
    $$select ops.transition_contract('00000000-0000-4000-8000-0000000000ff', 'sign')$$,
    '42501',
    NULL,
    'P3 a viewer cannot sign a contract (needs contract.approve)'
  );


RESET ROLE;


-- ── P4：停用账号 ────────────────────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000b4","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    'select ops.list_contracts()',
    '42501',
    NULL,
    'P4 a disabled operator cannot list contracts'
  );


RESET ROLE;


-- ── P6：有效运营成员但一个角色都没有 ────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000b6","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    $$select ops.create_contract('00000000-0000-4000-8000-0000000000c1', 'saas')$$,
    '42501',
    NULL,
    'P6 an operator without any role cannot create a contract'
  );


RESET ROLE;


-- ── 管理员视角：创建 ────────────────────────────────────────────────────────
-- 从这里起用 JWT 声明扮演管理员，不再 `SET LOCAL ROLE authenticated`：断言需要
-- 回读 ops 表取 id，而 authenticated 本轮连 SELECT 都没有（那正是 P1）。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}',
    TRUE
  );


CREATE TEMPORARY TABLE contract_step (payload jsonb) ON
COMMIT
DROP;


DELETE FROM contract_step;


INSERT INTO
  contract_step
SELECT
  ops.create_contract (
    p_customer_id => '00000000-0000-4000-8000-0000000000c1',
    p_sales_mode => 'saas',
    p_currency => 'CNY',
    p_payment_terms => '30 天',
    p_business_note => '主合同',
    p_items => '[{"packageId":"00000000-0000-4000-8000-0000000000e1","priceVersionId":"00000000-0000-4000-8000-0000000000f1","quantity":2,"termMonths":12},{"productId":"00000000-0000-4000-8000-0000000000d1","quantity":3,"unitPrice":100}]'::jsonb
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        contract_step
    ),
    'ok',
    'an admin creates a contract with two items'
  );


SELECT
  matches (
    (
      SELECT
        payload #>> '{contract,contract_no}'
      FROM
        contract_step
    ),
    '^HT-[0-9]{6}$',
    'the contract number follows the HT-000123 shape'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contract,status}'
      FROM
        contract_step
    ),
    'draft',
    'a new contract starts in draft'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contract,current_version_no}'
      FROM
        contract_step
    ),
    '0',
    'a draft contract has no version yet (current_version_no defaults to 0)'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contract,total_amount}'
      FROM
        contract_step
    ),
    '2700.00',
    'the total amount is recomputed from the items'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{items,0,amount}'
      FROM
        contract_step
    ),
    '2400.00',
    'amount = quantity * unit_price, recomputed in SQL'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{items,0,unit_price}'
      FROM
        contract_step
    ),
    '1200.00',
    'unit price is taken from the price version when it is not supplied'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{items,0,item_name_snapshot}'
      FROM
        contract_step
    ),
    '专业版',
    'the item name snapshot takes the package customer name'
  );


SELECT
  IS (
    jsonb_array_length(
      (
        SELECT
          payload -> 'items'
        FROM
          contract_step
      )
    ),
    2,
    'both items are stored'
  );


SELECT
  IS (
    ops.create_contract (
      p_customer_id => '00000000-0000-4000-8000-0000000000c1',
      p_sales_mode => 'saas',
      p_items => '[{"packageId":"00000000-0000-4000-8000-0000000000e1","priceVersionId":"00000000-0000-4000-8000-0000000000f1","quantity":1,"unitPrice":999}]'::jsonb
    ) ->> 'status',
    'price_mismatch',
    'a unit price that disagrees with the price version is refused'
  );


SELECT
  IS (
    ops.create_contract (
      p_customer_id => '00000000-0000-4000-8000-0000000000ff',
      p_sales_mode => 'saas'
    ) ->> 'status',
    'customer_not_found',
    'an unknown customer is refused'
  );


SELECT
  IS (
    ops.create_contract (
      p_customer_id => '00000000-0000-4000-8000-0000000000c1',
      p_sales_mode => 'marketplace'
    ) ->> 'status',
    'sales_mode_disabled',
    'an unknown sales mode is refused instead of hitting the check constraint'
  );


-- 契约 §5.4 的「400 销售方式未开放」必须在建单时就判，不能等到 sign：
-- 等到签署才拒会留下一张卖不出去的草稿，而 PATCH 改不了 sales_mode。
-- 夹具里产品 d1 只开了 saas（private 是 FALSE），因此这里用 private 必然被拒。
SELECT
  IS (
    ops.create_contract (
      p_customer_id => '00000000-0000-4000-8000-0000000000c1',
      p_sales_mode => 'private',
      p_items => '[{"productId":"00000000-0000-4000-8000-0000000000d1","unitPrice":100}]'::jsonb
    ) ->> 'status',
    'sales_mode_disabled',
    'a sales mode the product has not enabled is refused at creation'
  );


DELETE FROM contract_step;


INSERT INTO
  contract_step
SELECT
  ops.create_contract (
    p_customer_id => '00000000-0000-4000-8000-0000000000c1',
    p_sales_mode => 'saas',
    p_business_note => '空合同'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        contract_step
    ),
    'ok',
    'a draft contract may start without items'
  );


-- ── 列表与详情 ──────────────────────────────────────────────────────────────
SELECT
  IS (
    ops.list_contracts () -> 'total',
    '2'::jsonb,
    'the list returns both drafts'
  );


SELECT
  IS (
    ops.list_contracts (p_statuses => ARRAY['signed']) -> 'total',
    '0'::jsonb,
    'the status filter excludes contracts in other states'
  );


SELECT
  IS (
    ops.list_contracts (
      p_customer_id => '00000000-0000-4000-8000-0000000000c2'
    ) -> 'total',
    '0'::jsonb,
    'the customer filter excludes other customers'
  );


SELECT
  ok (
    (
      ops.get_contract (
        (
          SELECT
            id
          FROM
            ops.contracts
          WHERE
            business_note = '主合同'
        )
      )
    ) ?& ARRAY[
      'contract',
      'items',
      'receivables',
      'subscriptions',
      'licenses',
      'attachments'
    ],
    'the contract detail carries every collection key'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.get_contract (
        (
          SELECT
            id
          FROM
            ops.contracts
          WHERE
            business_note = '主合同'
        )
      ) -> 'items'
    ),
    2,
    'the contract detail carries its items'
  );


SELECT
  IS (
    ops.get_contract ('00000000-0000-4000-8000-0000000000ff') ->> 'status',
    'contract_not_found',
    'an unknown contract id returns contract_not_found'
  );


-- ── PATCH ───────────────────────────────────────────────────────────────────
SELECT
  IS (
    ops.update_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      ),
      p_expected_version => 99,
      p_payment_terms => '过期版本'
    ) ->> 'status',
    'version_mismatch',
    'a stale contract version is refused'
  );


SELECT
  IS (
    ops.update_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      ),
      p_expected_version => 99
    ) ->> 'current_version',
    '1',
    'the mismatch envelope reports the current version'
  );


SELECT
  IS (
    ops.update_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      ),
      p_expected_version => 1,
      p_payment_terms => '60 天',
      p_expires_on => '2027-12-31'
    ) #>> '{contract,payment_terms}',
    '60 天',
    'a draft contract can be patched'
  );


DELETE FROM contract_step;


INSERT INTO
  contract_step
SELECT
  ops.update_contract (
    (
      SELECT
        id
      FROM
        ops.contracts
      WHERE
        business_note = '主合同'
    ),
    p_expected_version => 2,
    p_items => '[{"productId":"00000000-0000-4000-8000-0000000000d1","quantity":5,"unitPrice":100}]'::jsonb,
    p_items_provided => TRUE
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contract,total_amount}'
      FROM
        contract_step
    ),
    '500.00',
    'replacing the items recomputes the total amount'
  );


SELECT
  IS (
    jsonb_array_length(
      (
        SELECT
          payload -> 'items'
        FROM
          contract_step
      )
    ),
    1,
    'the provided items replace the previous set as a whole'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contract,version}'
      FROM
        contract_step
    ),
    '3',
    'a contract update bumps the optimistic-lock version'
  );


-- ── submit 的三条守卫 ───────────────────────────────────────────────────────
SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '空合同'
      ),
      'submit',
      p_expected_version => 1
    ) ->> 'status',
    'items_required',
    'submitting a contract without items is refused'
  );


DELETE FROM contract_step;


INSERT INTO
  contract_step
SELECT
  ops.create_contract (
    p_customer_id => '00000000-0000-4000-8000-0000000000c2',
    p_sales_mode => 'saas',
    p_business_note => '暂停客户合同',
    p_items => '[{"productId":"00000000-0000-4000-8000-0000000000d1","quantity":1,"unitPrice":100}]'::jsonb
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        contract_step
    ),
    'ok',
    'a contract can be drafted for a suspended customer'
  );


SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '暂停客户合同'
      ),
      'submit',
      p_expected_version => 1
    ) ->> 'status',
    'customer_not_eligible',
    'submitting for a suspended customer is refused'
  );


DELETE FROM contract_step;


INSERT INTO
  contract_step
SELECT
  ops.create_contract (
    p_customer_id => '00000000-0000-4000-8000-0000000000c1',
    p_sales_mode => 'saas',
    p_business_note => '合计错误合同',
    p_items => '[{"productId":"00000000-0000-4000-8000-0000000000d1","quantity":1,"unitPrice":100}]'::jsonb
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        contract_step
    ),
    'ok',
    'the total-mismatch fixture is created'
  );


UPDATE ops.contracts
SET
  total_amount = 999
WHERE
  business_note = '合计错误合同';


SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '合计错误合同'
      ),
      'submit',
      p_expected_version => 1
    ) ->> 'status',
    'total_mismatch',
    'submit refuses a contract whose total does not match its items'
  );


-- ── 状态机：submit / withdraw ───────────────────────────────────────────────
DELETE FROM contract_step;


INSERT INTO
  contract_step
SELECT
  ops.transition_contract (
    (
      SELECT
        id
      FROM
        ops.contracts
      WHERE
        business_note = '主合同'
    ),
    'submit',
    '提交评审',
    p_expected_version => 3
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contract,status}'
      FROM
        contract_step
    ),
    'reviewing',
    'submit moves draft to reviewing'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contract,version}'
      FROM
        contract_step
    ),
    '4',
    'a transition bumps the optimistic-lock version'
  );


SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      ),
      'submit',
      p_expected_version => 4
    ) ->> 'status',
    'invalid_transition',
    'submitting a reviewing contract is an illegal edge'
  );


DELETE FROM contract_step;


INSERT INTO
  contract_step
SELECT
  ops.create_contract (
    p_customer_id => '00000000-0000-4000-8000-0000000000c1',
    p_sales_mode => 'saas',
    p_business_note => '撤回用例合同',
    p_items => '[{"productId":"00000000-0000-4000-8000-0000000000d1","quantity":1,"unitPrice":100}]'::jsonb
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        contract_step
    ),
    'ok',
    'the withdraw fixture is created'
  );


SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '撤回用例合同'
      ),
      'submit',
      p_expected_version => 1
    ) ->> 'status',
    'ok',
    'the withdraw fixture reaches reviewing'
  );


SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '撤回用例合同'
      ),
      'withdraw',
      '撤回修改',
      p_expected_version => 2
    ) #>> '{contract,status}',
    'draft',
    'withdraw moves reviewing back to draft'
  );


SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '撤回用例合同'
      ),
      'withdraw',
      '重复撤回',
      p_expected_version => 3
    ) ->> 'status',
    'invalid_transition',
    'withdrawing a draft contract is an illegal edge'
  );


-- ── sign 的销售方式守卫 ─────────────────────────────────────────────────────
-- 建单也要判销售方式（契约 §5.4 的 400「销售方式未开放」，见上方 create 区块），
-- 所以这里先把 private 打开让草稿能建，再在 sign 前关掉——两处守卫各证一次，
-- 不靠「建单不判」来造夹具。
UPDATE ops.product_sales_modes
SET
  is_enabled = TRUE
WHERE
  product_id = '00000000-0000-4000-8000-0000000000d1'
  AND sales_mode = 'private';


DELETE FROM contract_step;


INSERT INTO
  contract_step
SELECT
  ops.create_contract (
    p_customer_id => '00000000-0000-4000-8000-0000000000c1',
    p_sales_mode => 'private',
    p_business_note => '私有模式合同',
    p_items => '[{"productId":"00000000-0000-4000-8000-0000000000d1","quantity":1,"unitPrice":100}]'::jsonb
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        contract_step
    ),
    'ok',
    'a private-mode draft can be created for a product line'
  );


SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '私有模式合同'
      ),
      'submit',
      p_expected_version => 1
    ) ->> 'status',
    'ok',
    'the private-mode contract reaches reviewing'
  );


-- 草稿建好、也在评审了，此刻把销售方式关掉：sign 必须被拒。
-- 这一步就是「开关是产品维度的、可以事后变」的真实场景。
UPDATE ops.product_sales_modes
SET
  is_enabled = FALSE
WHERE
  product_id = '00000000-0000-4000-8000-0000000000d1'
  AND sales_mode = 'private';


SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '私有模式合同'
      ),
      'sign',
      p_signed_on => '2026-10-31',
      p_expected_version => 2
    ) ->> 'status',
    'sales_mode_disabled',
    'sign checks product_sales_modes.is_enabled for the contract sales mode'
  );


-- ── sign / activate 的正向路径 ──────────────────────────────────────────────
DELETE FROM contract_step;


INSERT INTO
  contract_step
SELECT
  ops.transition_contract (
    (
      SELECT
        id
      FROM
        ops.contracts
      WHERE
        business_note = '主合同'
    ),
    'sign',
    '客户签署',
    p_signed_on => '2026-10-31',
    p_expected_version => 4
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contract,status}'
      FROM
        contract_step
    ),
    'signed',
    'sign moves reviewing to signed'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contract,signed_on}'
      FROM
        contract_step
    ),
    '2026-10-31',
    'sign records the signed date'
  );


SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '合计错误合同'
      ),
      'sign',
      p_signed_on => '2026-10-31',
      p_expected_version => 1
    ) ->> 'status',
    'invalid_transition',
    'signing a draft contract is an illegal edge'
  );


DELETE FROM contract_step;


INSERT INTO
  contract_step
SELECT
  ops.transition_contract (
    (
      SELECT
        id
      FROM
        ops.contracts
      WHERE
        business_note = '主合同'
    ),
    'activate',
    '合同生效',
    p_effective_on => '2026-11-01',
    p_expected_version => 5
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contract,status}'
      FROM
        contract_step
    ),
    'active',
    'activate moves signed to active'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contract,current_version_no}'
      FROM
        contract_step
    ),
    '1',
    'activate raises current_version_no from 0 to 1'
  );


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        ops.contract_versions AS version
        JOIN ops.contracts AS contract ON contract.id = version.contract_id
      WHERE
        contract.business_note = '主合同'
    ),
    1::bigint,
    'activate writes exactly one contract version'
  );


SELECT
  IS (
    jsonb_typeof(
      (
        SELECT
          version.snapshot -> 'entitlementLines'
        FROM
          ops.contract_versions AS version
          JOIN ops.contracts AS contract ON contract.id = version.contract_id
        WHERE
          contract.business_note = '主合同'
          AND version.version_no = 1
      )
    ),
    'array',
    'the snapshot carries entitlementLines as an empty array, not null'
  );


SELECT
  IS (
    (
      SELECT
        version.snapshot #>> '{contract,status}'
      FROM
        ops.contract_versions AS version
        JOIN ops.contracts AS contract ON contract.id = version.contract_id
      WHERE
        contract.business_note = '主合同'
        AND version.version_no = 1
    ),
    'active',
    'the version snapshot records the contract state at activation'
  );


SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      ),
      'activate',
      '重复生效',
      p_expected_version => 6
    ) ->> 'status',
    'invalid_transition',
    'activating an active contract is an illegal edge'
  );


-- ── PATCH 已签署/已生效：不可变 ─────────────────────────────────────────────
SELECT
  IS (
    ops.update_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      ),
      p_expected_version => 6,
      p_payment_terms => '改不动'
    ) ->> 'status',
    'contract_immutable',
    'an active contract cannot be patched'
  );


SELECT
  IS (
    ops.update_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      ),
      p_expected_version => 6
    ) ->> 'current_status',
    'active',
    'the immutable envelope reports the current status'
  );


-- ── 变更单：起草 → 提交 → 批准 → 应用 ───────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000b2","role":"authenticated"}',
    TRUE
  );


DELETE FROM contract_step;


INSERT INTO
  contract_step
SELECT
  ops.create_contract_amendment (
    p_contract_id => (
      SELECT
        id
      FROM
        ops.contracts
      WHERE
        business_note = '主合同'
    ),
    p_reason => '调整套餐组合',
    p_header => '{"paymentTerms":"60 天"}'::jsonb,
    p_items => '[{"packageId":"00000000-0000-4000-8000-0000000000e1","priceVersionId":"00000000-0000-4000-8000-0000000000f1","quantity":1},{"packageId":"00000000-0000-4000-8000-0000000000e2","unitPrice":800,"quantity":2}]'::jsonb,
    p_header_provided => TRUE,
    p_items_provided => TRUE
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        contract_step
    ),
    'ok',
    'a sales operator creates an amendment'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{amendment,amendment_no}'
      FROM
        contract_step
    ),
    '1',
    'the first amendment is number 1'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{amendment,status}'
      FROM
        contract_step
    ),
    'draft',
    'a new amendment starts in draft'
  );


SELECT
  IS (
    ops.create_contract_amendment (
      p_contract_id => (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      ),
      p_reason => '重复变更单'
    ) ->> 'status',
    'amendment_conflict',
    'a second open amendment is refused'
  );


SELECT
  IS (
    ops.transition_contract_amendment (
      (
        SELECT
          contract.id
        FROM
          ops.contracts AS contract
        WHERE
          contract.business_note = '主合同'
      ),
      (
        SELECT
          amendment.id
        FROM
          ops.contract_amendments AS amendment
          JOIN ops.contracts AS contract ON contract.id = amendment.contract_id
        WHERE
          contract.business_note = '主合同'
          AND amendment.amendment_no = 1
      ),
      'submit',
      '提交审批',
      p_expected_version => 1
    ) #>> '{amendment,status}',
    'pending_approval',
    'submit moves the amendment to pending_approval'
  );


SELECT
  throws_ok (
    $$select ops.transition_contract_amendment(
      (select contract.id from ops.contracts as contract where contract.business_note = '主合同'),
      (select amendment.id from ops.contract_amendments as amendment
        join ops.contracts as contract on contract.id = amendment.contract_id
        where contract.business_note = '主合同' and amendment.amendment_no = 1),
      'approve', '批准', 2)$$,
    '42501',
    NULL,
    'P3 a sales operator cannot approve an amendment (needs contract.approve)'
  );


-- 换管理员批准：既能证明「换一个人可以批」，也让 approved_by 记下一个与
-- requested_by 不同的账号（职责分离的正向路径）。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    ops.transition_contract_amendment (
      (
        SELECT
          contract.id
        FROM
          ops.contracts AS contract
        WHERE
          contract.business_note = '主合同'
      ),
      (
        SELECT
          amendment.id
        FROM
          ops.contract_amendments AS amendment
          JOIN ops.contracts AS contract ON contract.id = amendment.contract_id
        WHERE
          contract.business_note = '主合同'
          AND amendment.amendment_no = 1
      ),
      'approve',
      '同意调整',
      p_expected_version => 2
    ) #>> '{amendment,status}',
    'approved',
    'a different approver can approve the amendment'
  );


SELECT
  IS (
    (
      SELECT
        amendment.approved_by
      FROM
        ops.contract_amendments AS amendment
        JOIN ops.contracts AS contract ON contract.id = amendment.contract_id
      WHERE
        contract.business_note = '主合同'
        AND amendment.amendment_no = 1
    ),
    '00000000-0000-4000-8000-0000000000a1'::uuid,
    'the approver is recorded on the amendment'
  );


SELECT
  throws_ok (
    $$insert into ops.contract_amendments (
      contract_id, amendment_no, reason, before_summary, after_summary, status,
      requested_by, approved_by
    ) values (
      (select id from ops.contracts where business_note = '主合同'),
      99, '自批约束', '{}'::jsonb, '{}'::jsonb, 'approved',
      '00000000-0000-4000-8000-0000000000a2',
      '00000000-0000-4000-8000-0000000000a2'
    )$$,
    '23514',
    NULL,
    'the segregation-of-duties check rejects approved_by = requested_by'
  );


DELETE FROM contract_step;


INSERT INTO
  contract_step
SELECT
  ops.transition_contract_amendment (
    (
      SELECT
        contract.id
      FROM
        ops.contracts AS contract
      WHERE
        contract.business_note = '主合同'
    ),
    (
      SELECT
        amendment.id
      FROM
        ops.contract_amendments AS amendment
        JOIN ops.contracts AS contract ON contract.id = amendment.contract_id
      WHERE
        contract.business_note = '主合同'
        AND amendment.amendment_no = 1
    ),
    'apply',
    '应用变更',
    p_expected_version => 3
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{amendment,status}'
      FROM
        contract_step
    ),
    'applied',
    'apply moves an approved amendment to applied'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{amendment,applied_version_no}'
      FROM
        contract_step
    ),
    '2',
    'apply records the version it produced'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contract,current_version_no}'
      FROM
        contract_step
    ),
    '2',
    'applying an amendment advances the contract version'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contract,payment_terms}'
      FROM
        contract_step
    ),
    '60 天',
    'applying an amendment writes the amended header'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contract,total_amount}'
      FROM
        contract_step
    ),
    '2800.00',
    'applying an amendment recomputes the total from the new items'
  );


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        ops.contract_versions AS version
        JOIN ops.contracts AS contract ON contract.id = version.contract_id
      WHERE
        contract.business_note = '主合同'
    ),
    2::bigint,
    'applying an amendment appends a second version snapshot'
  );


SELECT
  IS (
    ops.transition_contract_amendment (
      (
        SELECT
          contract.id
        FROM
          ops.contracts AS contract
        WHERE
          contract.business_note = '主合同'
      ),
      (
        SELECT
          amendment.id
        FROM
          ops.contract_amendments AS amendment
          JOIN ops.contracts AS contract ON contract.id = amendment.contract_id
        WHERE
          contract.business_note = '主合同'
          AND amendment.amendment_no = 1
      ),
      'apply',
      '重复应用',
      p_expected_version => 4
    ) ->> 'status',
    'invalid_transition',
    'applying an applied amendment is an illegal edge'
  );


-- 管理员自己发起、自己批准：RPC 层必须先返回业务信封，而不是撞 CHECK 变 500。
SELECT
  IS (
    ops.create_contract_amendment (
      p_contract_id => (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      ),
      p_reason => '自批用例'
    ) ->> 'status',
    'ok',
    'the admin creates a second amendment'
  );


SELECT
  IS (
    ops.transition_contract_amendment (
      (
        SELECT
          contract.id
        FROM
          ops.contracts AS contract
        WHERE
          contract.business_note = '主合同'
      ),
      (
        SELECT
          amendment.id
        FROM
          ops.contract_amendments AS amendment
          JOIN ops.contracts AS contract ON contract.id = amendment.contract_id
        WHERE
          contract.business_note = '主合同'
          AND amendment.amendment_no = 2
      ),
      'submit',
      '提交自批用例',
      p_expected_version => 1
    ) ->> 'status',
    'ok',
    'the admin submits the second amendment'
  );


SELECT
  IS (
    ops.transition_contract_amendment (
      (
        SELECT
          contract.id
        FROM
          ops.contracts AS contract
        WHERE
          contract.business_note = '主合同'
      ),
      (
        SELECT
          amendment.id
        FROM
          ops.contract_amendments AS amendment
          JOIN ops.contracts AS contract ON contract.id = amendment.contract_id
        WHERE
          contract.business_note = '主合同'
          AND amendment.amendment_no = 2
      ),
      'approve',
      '自己批准自己',
      p_expected_version => 2
    ) ->> 'status',
    'amendment_conflict',
    'self-approval returns an envelope instead of a check violation'
  );


-- ── 变更单归属校验：路径上的合同 id 必须与变更单真实归属一致 ──────────────────
-- 不校验时这条会返回 ok（已用变异验证确认：去掉归属判断后本条变红）。
-- 归属不符按「不存在」处理，不区分「变更单不存在」与「不属于这份合同」——
-- 区分等于允许用别的合同 id 探测变更单是否存在。
SELECT
  IS (
    ops.transition_contract_amendment (
      gen_random_uuid(),
      (
        SELECT
          amendment.id
        FROM
          ops.contract_amendments AS amendment
          JOIN ops.contracts AS contract ON contract.id = amendment.contract_id
        WHERE
          contract.business_note = '主合同'
          AND amendment.amendment_no = 1
      ),
      'approve',
      '跨合同审批',
      p_expected_version => 3
    ) ->> 'status',
    'amendment_not_found',
    'an amendment cannot be transitioned through another contract id'
  );


-- ── entitlement-preview：合并规则与 PACKAGE_NOT_ACTIVE ──────────────────────
SELECT
  IS (
    ops.contract_entitlement_preview (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      )
    ) ->> 'status',
    'ok',
    'the entitlement preview is returned for an existing contract'
  );


SELECT
  IS (
    ops.contract_entitlement_preview (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      )
    ) #>> '{features,0,featureKey}',
    'api',
    'features are ordered by feature key'
  );


SELECT
  IS (
    ops.contract_entitlement_preview (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      )
    ) #>> '{features,0,enabled}',
    'true',
    'a boolean feature keeps its enabled flag'
  );


SELECT
  IS (
    ops.contract_entitlement_preview (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      )
    ) #>> '{features,1,quota}',
    '50.00',
    'duplicate feature keys take the maximum quota'
  );


SELECT
  IS (
    ops.contract_entitlement_preview (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      )
    ) #>> '{features,1,enabled}',
    'false',
    'duplicate feature keys AND their enabled flags'
  );


SELECT
  IS (
    ops.contract_entitlement_preview (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      )
    ) #>> '{features,1,termMonths}',
    '24',
    'duplicate feature keys take the maximum term in months'
  );


SELECT
  IS (
    ops.contract_entitlement_preview (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      )
    ) #>> '{features,1,appliesTo}',
    'both',
    'conflicting appliesTo values collapse to both'
  );


SELECT
  IS (
    ops.contract_entitlement_preview (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      )
    ) #>> '{warnings,0,code}',
    'PACKAGE_NOT_ACTIVE',
    'a draft package produces a PACKAGE_NOT_ACTIVE warning'
  );


SELECT
  IS (
    ops.contract_entitlement_preview (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      )
    ) #>> '{warnings,0,packageId}',
    '00000000-0000-4000-8000-0000000000e2',
    'the warning names the package that is not active'
  );


-- ── 续约 ────────────────────────────────────────────────────────────────────
SELECT
  IS (
    ops.renew_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      ),
      p_effective_on => '2028-01-01',
      p_expires_on => '2028-12-31',
      p_reason => '太早'
    ) ->> 'status',
    'renewal_not_due',
    'renewing a contract that expires in more than 90 days is refused'
  );


DELETE FROM contract_step;


INSERT INTO
  contract_step
SELECT
  ops.renew_contract (
    (
      SELECT
        id
      FROM
        ops.contracts
      WHERE
        business_note = '主合同'
    ),
    p_effective_on => '2028-01-01',
    p_expires_on => '2028-12-31',
    p_reason => '提前续约',
    p_force => TRUE
  );


-- 续约会把商务备注一并复制过来（条款照旧），而后续断言靠 `business_note` 唯一
-- 定位原合同。这里把新合同的备注改名，保持定位唯一——测的是续约链，不是备注文案。
UPDATE ops.contracts
SET
  business_note = '续约合同'
WHERE
  renewed_from_contract_id = (
    SELECT
      id
    FROM
      ops.contracts
    WHERE
      business_note = '主合同'
      AND renewed_from_contract_id IS NULL
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        contract_step
    ),
    'ok',
    'force bypasses the renewal window'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contract,status}'
      FROM
        contract_step
    ),
    'draft',
    'a renewal creates a new draft contract'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contract,renewed_from_contract_id}'
      FROM
        contract_step
    ),
    (
      SELECT
        id::text
      FROM
        ops.contracts
      WHERE
        business_note = '主合同'
    ),
    'the renewal points back at the original contract'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contract,total_amount}'
      FROM
        contract_step
    ),
    '2800.00',
    'the renewal copies the items and their total'
  );


SELECT
  IS (
    (
      SELECT
        status
      FROM
        ops.contracts
      WHERE
        business_note = '主合同'
    ),
    'active',
    'the original contract is untouched by the renewal'
  );


-- ── terminate：confirmImpact、引用守卫、终态 ────────────────────────────────
SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      ),
      'terminate',
      '客户流失',
      p_confirm_impact => FALSE,
      p_expected_version => 7
    ) ->> 'status',
    'invalid_transition',
    'terminate without confirming the impact is refused'
  );


SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      ),
      'terminate',
      '客户流失',
      p_confirm_impact => FALSE,
      p_expected_version => 7
    ) ->> 'missing',
    'confirmImpact',
    'the refusal names the missing field'
  );


-- T-07 落地后 `ops.receivables` 是真表，原先的同事务替身表会撞名
-- （`relation "receivables" already exists`，整个文件在 setup 阶段中断）。
-- 改成插真实行：合同引用计数与终止守卫读的是同一张表，真表能证明的东西比替身多
-- ——替身只有两列，真表的 CHECK、唯一键与客户外键一并被这行数据走了一遍。
INSERT INTO
  ops.receivables (
    contract_id,
    customer_id,
    period_no,
    due_date,
    amount,
    currency
  )
SELECT
  contract.id,
  contract.customer_id,
  1,
  (ops.receivable_today () + 30),
  1000.00,
  contract.currency
FROM
  ops.contracts AS contract
WHERE
  contract.business_note = '主合同';


SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      ),
      'terminate',
      '客户流失',
      p_confirm_impact => TRUE,
      p_expected_version => 7
    ) ->> 'status',
    'referenced',
    'terminate is refused while a receivable references the contract'
  );


SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      ),
      'terminate',
      '客户流失',
      p_confirm_impact => TRUE,
      p_expected_version => 7
    ) #>> '{impact,receivables}',
    '1',
    'the referenced envelope carries the impact counts'
  );


DELETE FROM ops.receivables;


DELETE FROM contract_step;


INSERT INTO
  contract_step
SELECT
  ops.transition_contract (
    (
      SELECT
        id
      FROM
        ops.contracts
      WHERE
        business_note = '主合同'
    ),
    'terminate',
    '客户流失',
    p_confirm_impact => TRUE,
    p_expected_version => 7
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contract,status}'
      FROM
        contract_step
    ),
    'terminated',
    'terminate moves an active contract to terminated'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{contract,status_reason}'
      FROM
        contract_step
    ),
    '客户流失',
    'the termination reason is recorded'
  );


SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      ),
      'terminate',
      '再次终止',
      p_confirm_impact => TRUE,
      p_expected_version => 8
    ) ->> 'status',
    'invalid_transition',
    'terminated is a terminal state'
  );


-- ── expire：active → expired，终态不可再动 ─────────────────────────────────
DELETE FROM contract_step;


INSERT INTO
  contract_step
SELECT
  ops.create_contract (
    p_customer_id => '00000000-0000-4000-8000-0000000000c1',
    p_sales_mode => 'saas',
    p_business_note => '到期用例合同',
    p_items => '[{"productId":"00000000-0000-4000-8000-0000000000d1","quantity":1,"unitPrice":100}]'::jsonb
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        contract_step
    ),
    'ok',
    'the expiry fixture is created'
  );


SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '到期用例合同'
      ),
      'submit',
      p_expected_version => 1
    ) ->> 'status',
    'ok',
    'the expiry fixture reaches reviewing'
  );


SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '到期用例合同'
      ),
      'sign',
      p_signed_on => '2026-10-31',
      p_expected_version => 2
    ) ->> 'status',
    'ok',
    'the expiry fixture is signed'
  );


SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '到期用例合同'
      ),
      'activate',
      p_effective_on => '2026-10-31',
      p_expected_version => 3
    ) ->> 'status',
    'ok',
    'the expiry fixture is activated'
  );


SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '到期用例合同'
      ),
      'expire',
      '自然到期',
      p_expected_version => 4
    ) #>> '{contract,status}',
    'expired',
    'expire moves active to expired'
  );


SELECT
  IS (
    ops.transition_contract (
      (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '到期用例合同'
      ),
      'activate',
      '终态激活',
      p_expected_version => 5
    ) ->> 'status',
    'invalid_transition',
    'an expired contract cannot be activated'
  );


-- ── CHECK 约束：金额与编号 ──────────────────────────────────────────────────
SELECT
  throws_ok (
    $$insert into ops.contract_items (
      contract_id, product_id, sales_mode, billing_type, quantity, unit_price,
      amount, item_name_snapshot, line_no
    ) values (
      (select id from ops.contracts where business_note = '主合同'),
      '00000000-0000-4000-8000-0000000000d1', 'saas', 'periodic', 2, 10,
      999, '手写条目', 99
    )$$,
    '23514',
    NULL,
    'the amount check really rejects a hand-written amount'
  );


SELECT
  throws_ok (
    $$insert into ops.contracts (contract_no, customer_id, sales_mode, status)
      values (
        (select contract_no from ops.contracts where business_note = '主合同'),
        '00000000-0000-4000-8000-0000000000c1', 'saas', 'draft'
      )$$,
    '23505',
    NULL,
    'the contract number is unique at the table level'
  );


-- ── 附件 ────────────────────────────────────────────────────────────────────
DELETE FROM contract_step;


INSERT INTO
  contract_step
SELECT
  ops.create_contract_attachment (
    p_contract_id => (
      SELECT
        id
      FROM
        ops.contracts
      WHERE
        business_note = '主合同'
    ),
    p_file_name => '合同扫描.pdf',
    p_content_type => 'application/pdf',
    p_byte_size => 1024
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        contract_step
    ),
    'ok',
    'an attachment registration returns ok'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{attachment,status}'
      FROM
        contract_step
    ),
    'pending',
    'a freshly registered attachment is pending'
  );


SELECT
  matches (
    (
      SELECT
        payload #>> '{attachment,storage_path}'
      FROM
        contract_step
    ),
    '^contracts/[0-9a-f-]{36}/[0-9a-f-]{36}/合同扫描\.pdf$',
    'the storage path follows contracts/{contractId}/{attachmentId}/{fileName}'
  );


SELECT
  IS (
    ops.create_contract_attachment (
      p_contract_id => (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      ),
      p_file_name => '超大文件.pdf',
      p_content_type => 'application/pdf',
      p_byte_size => 26214401
    ) ->> 'status',
    'attachment_too_large',
    'an attachment above the size cap is refused'
  );


SELECT
  IS (
    ops.create_contract_attachment (
      p_contract_id => (
        SELECT
          id
        FROM
          ops.contracts
        WHERE
          business_note = '主合同'
      ),
      p_file_name => '脚本.sh',
      p_content_type => 'text/x-shellscript',
      p_byte_size => 10
    ) ->> 'status',
    'attachment_type_rejected',
    'a content type outside the whitelist is refused'
  );


SELECT
  IS (
    ops.complete_contract_attachment (
      (
        SELECT
          payload #>> '{attachment,id}'
        FROM
          contract_step
      )::uuid,
      'not-a-checksum'
    ) ->> 'status',
    'invalid_checksum',
    'a malformed checksum is refused with its own word, not as "not uploaded"'
  );


-- 校验和格式错与「文件没上传」是两件事，客户端据此给的提示也不同：前者改请求体，
-- 后者先去传文件。共用一个词时它只能笼统说一句「有问题」。
SELECT
  IS (
    ops.complete_contract_attachment (
      (
        SELECT
          payload #>> '{attachment,id}'
        FROM
          contract_step
      )::uuid,
      'not-a-checksum'
    ) ->> 'field',
    'checksumSha256',
    'the refusal names the field so the form can highlight it'
  );


DELETE FROM contract_step;


INSERT INTO
  contract_step
SELECT
  ops.complete_contract_attachment (
    (
      SELECT
        id
      FROM
        ops.contract_attachments
      WHERE
        file_name = '合同扫描.pdf'
    ),
    repeat('a', 64)
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{attachment,status}'
      FROM
        contract_step
    ),
    'stored',
    'complete moves an attachment from pending to stored'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{attachment,checksum_sha256}'
      FROM
        contract_step
    ),
    repeat('a', 64),
    'complete stores the checksum'
  );


SELECT
  IS (
    ops.complete_contract_attachment (
      (
        SELECT
          id
        FROM
          ops.contract_attachments
        WHERE
          file_name = '合同扫描.pdf'
      ),
      repeat('b', 64)
    ) ->> 'status',
    'ok',
    'completing an already stored attachment is a retry, not an error'
  );


-- 幂等返回不能顺手改行：重试没有产生新的上传，`uploaded_at` 与 `version`
-- 若跟着动，「这个附件何时被上传」的答案会随请求次数漂移。
SELECT
  IS (
    (
      SELECT
        attachment.version
      FROM
        ops.contract_attachments AS attachment
      WHERE
        attachment.file_name = '合同扫描.pdf'
    ),
    2,
    'a repeated complete leaves version alone'
  );


-- ── 附件的存储位置（API 在 complete 前用它做对象存在性校验） ────────────────
-- 断言路径形状而不是「等于表里那一列」：后者是自证——函数就是从那一列取的，
-- 它错了函数也错，而「以 contracts/ 开头的三段路径」是契约 §8 真正要求的东西。
SELECT
  ok (
    (
      SELECT
        ops.contract_attachment_location (attachment.id) #>> '{storage_path}'
      FROM
        ops.contract_attachments AS attachment
      WHERE
        attachment.file_name = '合同扫描.pdf'
    ) ~ '^contracts/[0-9a-f-]{36}/[0-9a-f-]{36}/',
    'L1 location hands the API a path shaped like contracts/{contract}/{attachment}/…'
  );


SELECT
  IS (
    (
      SELECT
        ops.contract_attachment_location (attachment.id) ->> 'attachment_status'
      FROM
        ops.contract_attachments AS attachment
      WHERE
        attachment.file_name = '合同扫描.pdf'
    ),
    'stored',
    'L2 location also reports the row status, so the caller need not query twice'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.list_contract_attachments (
        (
          SELECT
            id
          FROM
            ops.contracts
          WHERE
            business_note = '主合同'
        )
      ) -> 'items'
    ),
    1,
    'the attachment list returns the stored file'
  );


SELECT
  IS (
    ops.contract_attachment_access (
      (
        SELECT
          id
        FROM
          ops.contract_attachments
        WHERE
          file_name = '合同扫描.pdf'
      )
    ) #>> '{attachment,access_scope}',
    'contract.read',
    'the attachment access carries its access scope'
  );


SELECT
  IS (
    ops.contract_attachment_access ('00000000-0000-4000-8000-0000000000fe') ->> 'status',
    'attachment_not_found',
    'an unknown attachment returns attachment_not_found'
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
        event.action = 'contract.created'
    ),
    'contract.created is written to the audit trail'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'contract.updated'
    ),
    'contract.updated is written to the audit trail'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'contract.transitioned'
        AND event.after_summary ? 'from'
        AND event.after_summary ? 'to'
        AND event.after_summary ? 'reason'
    ),
    'contract.transitioned carries from/to/reason'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'contract.version_created'
    ),
    'contract.version_created is written to the audit trail'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'contract.amendment_created'
    ),
    'contract.amendment_created is written to the audit trail'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'contract.amendment_decided'
    ),
    'contract.amendment_decided is written to the audit trail'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'contract.attachment_added'
    ),
    'contract.attachment_added is written to the audit trail'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'contract.renewed'
    ),
    'contract.renewed is written to the audit trail'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;