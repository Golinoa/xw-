BEGIN;


SELECT
  plan (77);


-- ── 夹具 ────────────────────────────────────────────────────────────────────
-- 五个运营身份。分权是刻意的：`entitlement.request` / `approve` / `execute`
-- 是三个不同权限，只造一个「什么都能干」的账号，「按动作判权限」这条实现
-- 与「按端点判一个固定权限」的错误实现，在测试里会得到完全相同的结果。
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-0000000009b1',
    'authenticated',
    'authenticated',
    'ent-requester@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000009b2',
    'authenticated',
    'authenticated',
    'ent-approver@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000009b3',
    'authenticated',
    'authenticated',
    'ent-executor@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000009b4',
    'authenticated',
    'authenticated',
    'ent-viewer@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000009b5',
    'authenticated',
    'authenticated',
    'ent-norole@example.test'
  );


INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000009a1',
    '00000000-0000-4000-8000-0000000009b1',
    'ent-requester@example.test',
    '权益申请',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000009a2',
    '00000000-0000-4000-8000-0000000009b2',
    'ent-approver@example.test',
    '权益审批',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000009a3',
    '00000000-0000-4000-8000-0000000009b3',
    'ent-executor@example.test',
    '权益执行',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000009a4',
    '00000000-0000-4000-8000-0000000009b4',
    'ent-viewer@example.test',
    '权益只读',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000009a5',
    '00000000-0000-4000-8000-0000000009b5',
    'ent-norole@example.test',
    '权益无角色',
    'active'
  );


INSERT INTO
  ops.roles (id, code, name)
VALUES
  (
    '00000000-0000-4000-8000-000000000981',
    'ent_test_request',
    '权益申请（测试）'
  ),
  (
    '00000000-0000-4000-8000-000000000982',
    'ent_test_approve',
    '权益审批（测试）'
  ),
  (
    '00000000-0000-4000-8000-000000000983',
    'ent_test_execute',
    '权益执行（测试）'
  ),
  (
    '00000000-0000-4000-8000-000000000984',
    'ent_test_view',
    '权益只读（测试）'
  );


INSERT INTO
  ops.role_permissions (role_id, permission_code)
VALUES
  (
    '00000000-0000-4000-8000-000000000981',
    'entitlement.read'
  ),
  (
    '00000000-0000-4000-8000-000000000981',
    'entitlement.request'
  ),
  (
    '00000000-0000-4000-8000-000000000982',
    'entitlement.read'
  ),
  (
    '00000000-0000-4000-8000-000000000982',
    'entitlement.request'
  ),
  (
    '00000000-0000-4000-8000-000000000982',
    'entitlement.approve'
  ),
  (
    '00000000-0000-4000-8000-000000000983',
    'entitlement.read'
  ),
  (
    '00000000-0000-4000-8000-000000000983',
    'entitlement.execute'
  ),
  (
    '00000000-0000-4000-8000-000000000983',
    'tenant.retry'
  ),
  (
    '00000000-0000-4000-8000-000000000984',
    'entitlement.read'
  );


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
VALUES
  (
    '00000000-0000-4000-8000-0000000009a1',
    '00000000-0000-4000-8000-000000000981',
    '00000000-0000-4000-8000-0000000009a1'
  ),
  (
    '00000000-0000-4000-8000-0000000009a2',
    '00000000-0000-4000-8000-000000000982',
    '00000000-0000-4000-8000-0000000009a1'
  ),
  (
    '00000000-0000-4000-8000-0000000009a3',
    '00000000-0000-4000-8000-000000000983',
    '00000000-0000-4000-8000-0000000009a1'
  ),
  (
    '00000000-0000-4000-8000-0000000009a4',
    '00000000-0000-4000-8000-000000000984',
    '00000000-0000-4000-8000-0000000009a1'
  );


-- 功能字典：一个布尔、一个额度、一个期限，再加一个「只在变更申请里出现」的
-- 额度键（C 组用它证明 diff 的 added 是真算出来的，不是把请求原样回显）。
INSERT INTO
  ops.feature_definitions (feature_key, display_name, value_type, unit)
VALUES
  ('feature_a', '基础功能', 'boolean', NULL),
  ('feature_b', '席位数', 'quota', 'seats'),
  ('feature_c', '支持期', 'term', 'month'),
  ('feature_d', '存储额度', 'quota', 'GB');


INSERT INTO
  ops.products (id, code, name, lifecycle_status)
VALUES
  (
    '00000000-0000-4000-8000-0000000009e1',
    'PRD-ENT',
    '权益测试产品',
    'active'
  );


INSERT INTO
  ops.packages (
    id,
    product_id,
    internal_name,
    customer_name,
    sales_mode,
    billing_type,
    list_price,
    status
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000009f1',
    '00000000-0000-4000-8000-0000000009e1',
    '标准版',
    '标准版',
    'saas',
    'periodic',
    5000.00,
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000009f2',
    '00000000-0000-4000-8000-0000000009e1',
    '私有版',
    '私有版',
    'private',
    'fixed_term',
    200000.00,
    'active'
  );


INSERT INTO
  ops.package_features (
    package_id,
    feature_key,
    enabled,
    quota_value,
    applies_to
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000009f1',
    'feature_a',
    TRUE,
    NULL,
    'saas_tenant'
  ),
  (
    '00000000-0000-4000-8000-0000000009f1',
    'feature_b',
    TRUE,
    10.00,
    'saas_tenant'
  ),
  (
    '00000000-0000-4000-8000-0000000009f2',
    'feature_a',
    TRUE,
    NULL,
    'both'
  );


INSERT INTO
  ops.customers (id, name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000009c1',
    '权益测试客户甲',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000009c2',
    '权益测试客户乙',
    'active'
  );


INSERT INTO
  ops.contracts (
    id,
    customer_id,
    sales_mode,
    status,
    total_amount,
    currency,
    effective_on
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000009d1',
    '00000000-0000-4000-8000-0000000009c1',
    'saas',
    'active',
    60000.00,
    'CNY',
    DATE '2026-01-01'
  ),
  (
    '00000000-0000-4000-8000-0000000009d2',
    '00000000-0000-4000-8000-0000000009c1',
    'saas',
    'draft',
    1000.00,
    'CNY',
    NULL
  ),
  (
    '00000000-0000-4000-8000-0000000009d3',
    '00000000-0000-4000-8000-0000000009c1',
    'private',
    'active',
    200000.00,
    'CNY',
    DATE '2026-02-01'
  ),
  (
    '00000000-0000-4000-8000-0000000009d4',
    '00000000-0000-4000-8000-0000000009c2',
    'saas',
    'active',
    3000.00,
    'CNY',
    DATE '2026-01-01'
  );


INSERT INTO
  ops.contract_items (
    id,
    contract_id,
    product_id,
    package_id,
    sales_mode,
    billing_type,
    quantity,
    unit_price,
    amount,
    item_name_snapshot,
    line_no
  )
VALUES
  (
    '00000000-0000-4000-8000-000000000a01',
    '00000000-0000-4000-8000-0000000009d1',
    '00000000-0000-4000-8000-0000000009e1',
    '00000000-0000-4000-8000-0000000009f1',
    'saas',
    'periodic',
    1,
    5000.00,
    5000.00,
    '标准版',
    1
  ),
  (
    '00000000-0000-4000-8000-000000000a02',
    '00000000-0000-4000-8000-0000000009d2',
    '00000000-0000-4000-8000-0000000009e1',
    '00000000-0000-4000-8000-0000000009f1',
    'saas',
    'periodic',
    1,
    1000.00,
    1000.00,
    '标准版',
    1
  ),
  (
    '00000000-0000-4000-8000-000000000a03',
    '00000000-0000-4000-8000-0000000009d3',
    '00000000-0000-4000-8000-0000000009e1',
    '00000000-0000-4000-8000-0000000009f2',
    'private',
    'fixed_term',
    1,
    200000.00,
    200000.00,
    '私有版',
    1
  ),
  (
    '00000000-0000-4000-8000-000000000a04',
    '00000000-0000-4000-8000-0000000009d1',
    '00000000-0000-4000-8000-0000000009e1',
    '00000000-0000-4000-8000-0000000009f1',
    'saas',
    'periodic',
    1,
    5000.00,
    5000.00,
    '标准版二期',
    2
  ),
  (
    '00000000-0000-4000-8000-000000000a05',
    '00000000-0000-4000-8000-0000000009d1',
    '00000000-0000-4000-8000-0000000009e1',
    '00000000-0000-4000-8000-0000000009f1',
    'saas',
    'periodic',
    1,
    5000.00,
    5000.00,
    '标准版三期',
    3
  ),
  (
    '00000000-0000-4000-8000-000000000a06',
    '00000000-0000-4000-8000-0000000009d4',
    '00000000-0000-4000-8000-0000000009e1',
    '00000000-0000-4000-8000-0000000009f1',
    'saas',
    'periodic',
    1,
    3000.00,
    3000.00,
    '标准版',
    1
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000009b1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


-- ── S：建订阅 ────────────────────────────────────────────────────────────────
SELECT
  IS (
    ops.create_subscription (
      p_customer_id => '00000000-0000-4000-8000-0000000009c1',
      p_contract_item_id => '00000000-0000-4000-8000-000000000a01',
      p_billing_cycle => 'yearly',
      p_starts_on => DATE '2026-01-01',
      p_ends_on => DATE '2027-12-31',
      p_auto_renew_intent => TRUE,
      p_features => '[{"featureKey":"feature_c","termMonths":12}]'::jsonb,
      p_reason => '首期开通'
    ) ->> 'status',
    'ok',
    'S1 requester creates a draft subscription'
  );


RESET ROLE;


SELECT
  set_config(
    'ent.sub_a',
    (
      SELECT
        id::text
      FROM
        ops.subscriptions
      WHERE
        contract_item_id = '00000000-0000-4000-8000-000000000a01'
    ),
    FALSE
  ),
  set_config(
    'ent.snap_a',
    (
      SELECT
        current_snapshot_id::text
      FROM
        ops.subscriptions
      WHERE
        contract_item_id = '00000000-0000-4000-8000-000000000a01'
    ),
    FALSE
  );


SET
  local role authenticated;


SELECT
  IS (
    ops.get_subscription (current_setting('ent.sub_a')::uuid) -> 'subscription' ->> 'status',
    'draft',
    'S2 new subscription starts in draft'
  );


SELECT
  matches (
    ops.get_subscription (current_setting('ent.sub_a')::uuid) -> 'subscription' ->> 'subscription_no',
    '^SUB-[0-9]{6}$',
    'S3 subscription number comes from the sequence'
  );


SELECT
  IS (
    ops.get_subscription (current_setting('ent.sub_a')::uuid) -> 'snapshot' ->> 'line_count',
    '3',
    'S4 snapshot merges package features with the requested override'
  );


SELECT
  IS (
    ops.get_subscription (current_setting('ent.sub_a')::uuid) -> 'snapshot' ->> 'target_scope',
    'saas_tenant',
    'S5 subscription snapshot targets the saas tenant scope'
  );


SELECT
  IS (
    ops.create_subscription (
      p_customer_id => '00000000-0000-4000-8000-0000000009c1',
      p_contract_item_id => '00000000-0000-4000-8000-000000000a02',
      p_billing_cycle => 'yearly',
      p_starts_on => DATE '2026-01-01'
    ) ->> 'status',
    'contract_not_active',
    'S6 a draft contract cannot be activated into a subscription'
  );


SELECT
  IS (
    ops.create_subscription (
      p_customer_id => '00000000-0000-4000-8000-0000000009c2',
      p_contract_item_id => '00000000-0000-4000-8000-000000000a01',
      p_billing_cycle => 'yearly',
      p_starts_on => DATE '2026-01-01'
    ) ->> 'status',
    'customer_mismatch',
    'S7 the contract item must belong to the requested customer'
  );


SELECT
  IS (
    ops.create_subscription (
      p_customer_id => '00000000-0000-4000-8000-0000000009c1',
      p_contract_item_id => '00000000-0000-4000-8000-000000000a03',
      p_billing_cycle => 'yearly',
      p_starts_on => DATE '2026-01-01'
    ) ->> 'status',
    'sales_mode_mismatch',
    'S8 a private item cannot become a saas subscription'
  );


SELECT
  IS (
    ops.create_subscription (
      p_customer_id => '00000000-0000-4000-8000-0000000009c1',
      p_contract_item_id => '00000000-0000-4000-8000-000000000a04',
      p_billing_cycle => 'yearly',
      p_starts_on => DATE '2026-01-01',
      p_features => '[{"featureKey":"feature_zzz","enabled":true}]'::jsonb
    ) ->> 'status',
    'feature_unknown',
    'S9 an unknown feature key is rejected'
  );


SELECT
  IS (
    ops.create_subscription (
      p_customer_id => '00000000-0000-4000-8000-0000000009c1',
      p_contract_item_id => '00000000-0000-4000-8000-000000000a04',
      p_billing_cycle => 'yearly',
      p_starts_on => DATE '2026-01-01',
      p_features => '[{"featureKey":"feature_a"},{"featureKey":"feature_a"}]'::jsonb
    ) ->> 'status',
    'feature_duplicate',
    'S10 the same feature key twice in one request is rejected'
  );


SELECT
  IS (
    ops.create_subscription (
      p_customer_id => '00000000-0000-4000-8000-0000000009c1',
      p_contract_item_id => '00000000-0000-4000-8000-000000000a01',
      p_billing_cycle => 'yearly',
      p_starts_on => DATE '2026-01-01'
    ) ->> 'status',
    'duplicate_subscription',
    'S11 the same contract item cannot be opened twice'
  );


SELECT
  IS (
    ops.create_subscription (
      p_customer_id => '00000000-0000-4000-8000-0000000009c1',
      p_contract_item_id => '00000000-0000-4000-8000-000000000a04',
      p_billing_cycle => 'yearly',
      p_starts_on => DATE '2026-02-01',
      p_ends_on => DATE '2027-01-31',
      p_features => '[{"featureKey":"feature_b","enabled":false}]'::jsonb
    ) ->> 'status',
    'ok',
    'S12 a second subscription is created on another item'
  );


SELECT
  IS (
    ops.create_subscription (
      p_customer_id => '00000000-0000-4000-8000-0000000009c1',
      p_contract_item_id => '00000000-0000-4000-8000-000000000a05',
      p_billing_cycle => 'monthly',
      p_starts_on => DATE '2026-03-01'
    ) ->> 'status',
    'ok',
    'S13 a third subscription is created for the terminal-state case'
  );


RESET ROLE;


SELECT
  set_config(
    'ent.sub_b',
    (
      SELECT
        id::text
      FROM
        ops.subscriptions
      WHERE
        contract_item_id = '00000000-0000-4000-8000-000000000a04'
    ),
    FALSE
  ),
  set_config(
    'ent.sub_c',
    (
      SELECT
        id::text
      FROM
        ops.subscriptions
      WHERE
        contract_item_id = '00000000-0000-4000-8000-000000000a05'
    ),
    FALSE
  );


SET
  local role authenticated;


-- 显式 `enabled=false` 必须能盖掉套餐的 `true`。这条容易在实现里丢掉：
-- `coalesce(请求值, 细则值, true)` 写成 `coalesce(细则值, 请求值, true)` 时，
-- 套餐说 true 就永远是 true，而「客户把某个功能关了」是升级/降级里最常见的动作。
SELECT
  IS (
    (
      SELECT
        line ->> 'enabled'
      FROM
        jsonb_array_elements(
          ops.get_subscription (current_setting('ent.sub_b')::uuid) -> 'snapshot' -> 'lines'
        ) AS line
      WHERE
        line ->> 'feature_key' = 'feature_b'
    ),
    'false',
    'S14 an explicit enabled=false overrides the package default'
  );


-- ── T：订阅状态迁移 ─────────────────────────────────────────────────────────
SELECT
  IS (
    ops.transition_entitlement_subject (
      'subscription',
      current_setting('ent.sub_a')::uuid,
      'submit',
      NULL,
      1
    ) ->> 'status',
    'ok',
    'T1 submit moves the draft to pending approval'
  );


SELECT
  IS (
    ops.get_subscription (current_setting('ent.sub_a')::uuid) -> 'subscription' ->> 'status',
    'pending_approval',
    'T2 the subscription waits for approval'
  );


-- 未审批即下发：契约 §3.5 与 T-09 验收断言都要求 APPROVAL_REQUIRED，
-- 而不是「动作不存在」——前者让用户去催审批，后者让人以为点错了按钮。
--
-- 用执行人（丙）来试，因为「未审批就下发」这个动作本身需要 `entitlement.execute`：
-- 换成一个没有该权限的人来试，先撞上的是 403，测的就不是这条守卫了。
RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000009b3","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    ops.transition_entitlement_subject (
      'subscription',
      current_setting('ent.sub_a')::uuid,
      'suspend',
      '想直接停掉'
    ) ->> 'status',
    'approval_required',
    'T3 suspending before approval reports approval_required'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000009b2","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    ops.transition_entitlement_subject (
      'subscription',
      current_setting('ent.sub_a')::uuid,
      'approve',
      NULL,
      1
    ) ->> 'status',
    'version_mismatch',
    'T4 a stale version is rejected'
  );


SELECT
  IS (
    ops.transition_entitlement_subject (
      'subscription',
      current_setting('ent.sub_a')::uuid,
      'approve',
      NULL,
      2
    ) ->> 'status',
    'ok',
    'T5 another operator approves and the subscription becomes active'
  );


SELECT
  IS (
    ops.get_subscription (current_setting('ent.sub_a')::uuid) -> 'subscription' ->> 'status',
    'active',
    'T6 approval activates the subscription'
  );


-- 乙同时有 request 与 approve（现实中「主管既提单也审别人的单」很常见）。
-- 这两条都在乙的身份下跑：`submit` 要 request，`approve` 要 approve。
SELECT
  IS (
    ops.transition_entitlement_subject (
      'subscription',
      current_setting('ent.sub_a')::uuid,
      'submit'
    ) ->> 'status',
    'invalid_transition',
    'T7 submit is not allowed once active'
  );


SELECT
  IS (
    ops.transition_entitlement_subject (
      'subscription',
      current_setting('ent.sub_b')::uuid,
      'approve'
    ) ->> 'status',
    'invalid_transition',
    'T8 a draft cannot be approved directly'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000009b3","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    ops.transition_entitlement_subject (
      'subscription',
      current_setting('ent.sub_a')::uuid,
      'mark_expired'
    ) ->> 'status',
    'not_expired',
    'T9 a subscription ending in the future cannot be marked expired'
  );


SELECT
  IS (
    ops.transition_entitlement_subject (
      'subscription',
      current_setting('ent.sub_a')::uuid,
      'suspend'
    ) ->> 'status',
    'reason_required',
    'T10 suspending requires a reason'
  );


SELECT
  IS (
    ops.transition_entitlement_subject (
      'subscription',
      current_setting('ent.sub_a')::uuid,
      'suspend',
      '客户欠费'
    ) ->> 'status',
    'ok',
    'T11 suspend with a reason succeeds'
  );


SELECT
  IS (
    ops.get_subscription (current_setting('ent.sub_a')::uuid) -> 'subscription' ->> 'status',
    'suspended',
    'T12 the subscription is suspended'
  );


SELECT
  IS (
    ops.transition_entitlement_subject (
      'subscription',
      current_setting('ent.sub_a')::uuid,
      'resume',
      '欠费结清'
    ) ->> 'status',
    'ok',
    'T13 resume brings it back to active'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000009b2","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    ops.transition_entitlement_subject (
      'subscription',
      current_setting('ent.sub_c')::uuid,
      'submit'
    ) ->> 'status',
    'ok',
    'T14 the third subscription is submitted'
  );


SELECT
  IS (
    ops.transition_entitlement_subject (
      'subscription',
      current_setting('ent.sub_c')::uuid,
      'approve'
    ) ->> 'status',
    'ok',
    'T15 the third subscription is approved'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000009b3","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    ops.transition_entitlement_subject (
      'subscription',
      current_setting('ent.sub_c')::uuid,
      'revoke',
      '合同提前终止'
    ) ->> 'status',
    'ok',
    'T16 revoke moves the subscription to revoked'
  );


-- 终态：任何动作都不再被接受。用 `revoke` 而不是 `submit`，是为了留在丙的
-- 身份里——`submit` 需要 `entitlement.request`，丙没有，那样测到的会是 403。
SELECT
  IS (
    ops.transition_entitlement_subject (
      'subscription',
      current_setting('ent.sub_c')::uuid,
      'revoke',
      '再撤一次'
    ) ->> 'status',
    'invalid_transition',
    'T17 revoked is terminal'
  );


-- ── P：权限 ────────────────────────────────────────────────────────────────
RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000009b5","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    $$select ops.create_subscription (
      '00000000-0000-4000-8000-0000000009c1',
      '00000000-0000-4000-8000-000000000a05',
      'yearly',
      DATE '2026-05-01'
    )$$,
    '42501',
    NULL,
    'P1 an operator without roles cannot create a subscription'
  );


SELECT
  throws_ok (
    $$select ops.get_subscription ('00000000-0000-4000-8000-0000000009a1')$$,
    '42501',
    NULL,
    'P2 an operator without roles cannot read subscriptions'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000009b4","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    $$select ops.create_subscription (
      '00000000-0000-4000-8000-0000000009c1',
      '00000000-0000-4000-8000-000000000a05',
      'yearly',
      DATE '2026-05-01'
    )$$,
    '42501',
    NULL,
    'P3 a read-only operator cannot create a subscription'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000009b1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


-- 「按动作判权限」的证明：甲有 `entitlement.request` 但没有 `approve`。
-- 若实现按端点固定 require 一个权限，这条会通过。
SELECT
  throws_ok (
    $$select ops.transition_entitlement_subject (
      'subscription', (select current_setting('ent.sub_a'))::uuid, 'approve'
    )$$,
    '42501',
    NULL,
    'P4 the requester cannot approve'
  );


-- ── L：私有化授权 ──────────────────────────────────────────────────────────
SELECT
  IS (
    ops.create_license (
      p_customer_id => '00000000-0000-4000-8000-0000000009c1',
      p_contract_item_id => '00000000-0000-4000-8000-000000000a03',
      p_deployment_instance_id => '00000000-0000-4000-8000-000000000b11',
      p_license_mode => 'perpetual',
      p_valid_from => DATE '2026-02-01',
      p_maintenance_until => DATE '2027-02-01',
      p_reason => '永久授权'
    ) ->> 'status',
    'ok',
    'L1 a perpetual license is created'
  );


RESET ROLE;


SELECT
  set_config(
    'ent.lic_a',
    (
      SELECT
        id::text
      FROM
        ops.private_licenses
      WHERE
        contract_item_id = '00000000-0000-4000-8000-000000000a03'
        AND license_mode = 'perpetual'
    ),
    FALSE
  ),
  set_config(
    'ent.lic_snap',
    (
      SELECT
        current_snapshot_id::text
      FROM
        ops.private_licenses
      WHERE
        contract_item_id = '00000000-0000-4000-8000-000000000a03'
        AND license_mode = 'perpetual'
    ),
    FALSE
  );


SET
  local role authenticated;


SELECT
  IS (
    ops.create_license (
      p_customer_id => '00000000-0000-4000-8000-0000000009c1',
      p_contract_item_id => '00000000-0000-4000-8000-000000000a03',
      p_deployment_instance_id => '00000000-0000-4000-8000-000000000b12',
      p_license_mode => 'perpetual',
      p_valid_from => DATE '2026-02-01',
      p_valid_to => DATE '2029-02-01'
    ) ->> 'status',
    'perpetual_with_valid_to',
    'L2 a perpetual license cannot carry valid_to'
  );


SELECT
  IS (
    ops.create_license (
      p_customer_id => '00000000-0000-4000-8000-0000000009c1',
      p_contract_item_id => '00000000-0000-4000-8000-000000000a03',
      p_deployment_instance_id => '00000000-0000-4000-8000-000000000b12',
      p_license_mode => 'term',
      p_valid_from => DATE '2026-02-01'
    ) ->> 'status',
    'term_requires_valid_to',
    'L3 a term license must carry valid_to'
  );


SELECT
  IS (
    ops.create_license (
      p_customer_id => '00000000-0000-4000-8000-0000000009c1',
      p_contract_item_id => '00000000-0000-4000-8000-000000000a03',
      p_license_mode => 'term',
      p_valid_from => DATE '2026-02-01',
      p_valid_to => current_date + 20,
      p_reason => '订阅制授权'
    ) ->> 'status',
    'ok',
    'L4 a term license is created without an instance'
  );


SELECT
  IS (
    ops.create_license (
      p_customer_id => '00000000-0000-4000-8000-0000000009c1',
      p_contract_item_id => '00000000-0000-4000-8000-000000000a03',
      p_deployment_instance_id => '00000000-0000-4000-8000-000000000b11',
      p_license_mode => 'term',
      p_valid_from => DATE '2026-02-01',
      p_valid_to => DATE '2027-02-01'
    ) ->> 'status',
    'duplicate_license',
    'L5 one deployment instance cannot hold two live licenses'
  );


SELECT
  IS (
    ops.create_license (
      p_customer_id => '00000000-0000-4000-8000-0000000009c1',
      p_contract_item_id => '00000000-0000-4000-8000-000000000a03',
      p_license_mode => 'term',
      p_valid_from => DATE '2026-02-01',
      p_valid_to => DATE '2027-02-01',
      p_maintenance_until => DATE '2026-01-01'
    ) ->> 'status',
    'invalid_maintenance_period',
    'L6 maintenance cannot start before the license does'
  );


SELECT
  IS (
    ops.create_license (
      p_customer_id => '00000000-0000-4000-8000-0000000009c1',
      p_contract_item_id => '00000000-0000-4000-8000-000000000a05',
      p_license_mode => 'perpetual',
      p_valid_from => DATE '2026-02-01'
    ) ->> 'status',
    'sales_mode_mismatch',
    'L7 a saas item cannot become a private license'
  );


SELECT
  IS (
    ops.get_license (current_setting('ent.lic_a')::uuid) -> 'license' ->> 'valid_to',
    NULL,
    'L8 a perpetual license has no valid_to'
  );


-- 表约束兜底：绕过 RPC 直接插也不行。这一条是「永久授权不得带有效期」的
-- 第二层——RPC 那层给的是能读懂的 reason，这层保证没有第三条写入路径。
RESET ROLE;


SELECT
  throws_ok (
    $$insert into ops.private_licenses (
      customer_id, contract_id, contract_item_id, license_mode,
      valid_from, valid_to, status
    ) values (
      '00000000-0000-4000-8000-0000000009c1',
      '00000000-0000-4000-8000-0000000009d3',
      '00000000-0000-4000-8000-000000000a03',
      'perpetual', DATE '2026-02-01', DATE '2029-02-01', 'draft'
    )$$,
    '23514',
    NULL,
    'L9 the table rejects a perpetual license with valid_to'
  );


SELECT
  IS (
    (
      SELECT
        target_scope || '|' || coalesce(target_ref::text, '-')
      FROM
        ops.entitlement_snapshots
      WHERE
        id = current_setting('ent.lic_snap')::uuid
    ),
    'private_instance|00000000-0000-4000-8000-000000000b11',
    'L10 the license snapshot records the instance it was issued to'
  );


-- ── C：权益变更申请 ────────────────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000009b1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    ops.create_entitlement_change_request (
      p_subject_type => 'subscription',
      p_subject_id => current_setting('ent.sub_a')::uuid,
      p_change_type => 'quota_change',
      p_reason => '客户扩席',
      p_proposed_features => '[{"featureKey":"feature_b","quotaValue":20},{"featureKey":"feature_d","quotaValue":5}]'::jsonb
    ) ->> 'status',
    'ok',
    'C1 a change request is submitted'
  );


RESET ROLE;


SELECT
  set_config(
    'ent.cr_a',
    (
      SELECT
        id::text
      FROM
        ops.entitlement_change_requests
      WHERE
        subject_id = current_setting('ent.sub_a')::uuid
    ),
    FALSE
  );


SET
  local role authenticated;


SELECT
  IS (
    ops.get_entitlement_change_request (current_setting('ent.cr_a')::uuid) -> 'change_request' ->> 'status',
    'pending_approval',
    'C2 a new change request waits for approval'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.get_entitlement_change_request (current_setting('ent.cr_a')::uuid) -> 'diff' -> 'added'
    ),
    '1',
    'C3 diff.added counts only the freshly introduced feature'
  );


SELECT
  IS (
    ops.get_entitlement_change_request (current_setting('ent.cr_a')::uuid) -> 'diff' -> 'added' -> 0 ->> 'feature_key',
    'feature_d',
    'C4 diff.added names the new feature'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.get_entitlement_change_request (current_setting('ent.cr_a')::uuid) -> 'diff' -> 'changed'
    ),
    '1',
    'C5 diff.changed counts only the semantic change'
  );


-- 基线是「当前快照」而不是「套餐权益」：套餐里只有 feature_a / feature_b，
-- 而开通时单独加购了 feature_c。若实现以套餐为基线，C6 会掉到 3。
SELECT
  IS (
    jsonb_array_length(
      ops.get_entitlement_change_request (current_setting('ent.cr_a')::uuid) -> 'change_request' -> 'after_summary' -> 'lines'
    ),
    '4',
    'C6 the proposal is built on the current snapshot, not on the package'
  );


SELECT
  IS (
    ops.create_entitlement_change_request (
      p_subject_type => 'subscription',
      p_subject_id => current_setting('ent.sub_b')::uuid,
      p_change_type => 'upgrade',
      p_reason => '草案上直接升级'
    ) ->> 'status',
    'subject_not_active',
    'C7 a draft subscription cannot receive change requests'
  );


SELECT
  IS (
    ops.create_entitlement_change_request (
      p_subject_type => 'subscription',
      p_subject_id => current_setting('ent.sub_a')::uuid,
      p_change_type => 'quota_change',
      p_reason => '   '
    ) ->> 'status',
    'reason_required',
    'C8 a change request requires a reason'
  );


SELECT
  IS (
    ops.create_entitlement_change_request (
      p_subject_type => 'subscription',
      p_subject_id => current_setting('ent.sub_a')::uuid,
      p_change_type => 'explode',
      p_reason => '非法类型'
    ) ->> 'status',
    'invalid_change_type',
    'C9 an unknown change type is rejected'
  );


-- 自批：契约 §3.5 给变更单加了 `CHECK(approved_by <> requested_by)`，§6.4 又
-- 点名「变更单申请人自批」。乙同时有 request 与 approve，所以这条路真的可达；
-- 换成甲来测会先撞 403（没有 approve 权限），测到的是权限而不是守卫。
RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000009b2","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  set_config(
    'ent.cr_b',
    ops.create_entitlement_change_request (
      p_subject_type => 'subscription',
      p_subject_id => current_setting('ent.sub_a')::uuid,
      p_change_type => 'upgrade',
      p_reason => '自己提单自己批'
    ) -> 'change_request' ->> 'id',
    FALSE
  );


SELECT
  IS (
    ops.transition_entitlement_change_request (current_setting('ent.cr_b')::uuid, 'approve') ->> 'status',
    'segregation_of_duty',
    'C10 the requester cannot approve their own change request'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000009b3","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    ops.transition_entitlement_change_request (current_setting('ent.cr_a')::uuid, 'execute') ->> 'status',
    'approval_required',
    'C11 executing before approval reports approval_required'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000009b2","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    ops.transition_entitlement_change_request (
      current_setting('ent.cr_a')::uuid,
      'approve',
      '同意扩席'
    ) ->> 'status',
    'ok',
    'C12 another operator approves the change request'
  );


SELECT
  IS (
    ops.get_entitlement_change_request (current_setting('ent.cr_a')::uuid) -> 'change_request' ->> 'status',
    'approved',
    'C13 the change request is approved'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000009b3","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    ops.transition_entitlement_change_request (current_setting('ent.cr_a')::uuid, 'execute') ->> 'status',
    'ok',
    'C14 execute lands the approved change'
  );


SELECT
  IS (
    ops.get_subscription (current_setting('ent.sub_a')::uuid) -> 'subscription' ->> 'status',
    'active',
    'C15 a quota_change leaves the subscription status untouched'
  );


-- 表约束：申请人自批过不了 CHECK。RPC 那层给的是 403 + rule，这层保证
-- 任何绕过端点的写入也做不到自批。
RESET ROLE;


SELECT
  throws_ok (
    $$insert into ops.entitlement_change_requests (
      subject_type, subject_id, change_type, status, reason,
      before_summary, after_summary, requested_by, approved_by
    ) values (
      'subscription',
      (select current_setting('ent.sub_a'))::uuid,
      'quota_change', 'approved', '自批试试',
      '{"lines":[]}'::jsonb, '{"lines":[]}'::jsonb,
      '00000000-0000-4000-8000-0000000009a1',
      '00000000-0000-4000-8000-0000000009a1'
    )$$,
    '23514',
    NULL,
    'C16 the table rejects self approval'
  );


-- ── V：快照不可变与内容哈希 ────────────────────────────────────────────────
SELECT
  set_config(
    'ent.hash_a',
    (
      SELECT
        content_hash
      FROM
        ops.entitlement_snapshots
      WHERE
        id = current_setting('ent.snap_a')::uuid
    ),
    FALSE
  );


INSERT INTO
  ops.package_features (
    package_id,
    feature_key,
    enabled,
    quota_value,
    applies_to
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000009f1',
    'feature_d',
    TRUE,
    1.00,
    'saas_tenant'
  )
ON CONFLICT (package_id, feature_key) DO UPDATE
SET
  quota_value = 1.00;


UPDATE ops.package_features
SET
  quota_value = 99.00
WHERE
  package_id = '00000000-0000-4000-8000-0000000009f1'
  AND feature_key = 'feature_b';


SELECT
  IS (
    (
      SELECT
        quota_value
      FROM
        ops.entitlement_snapshot_lines
      WHERE
        snapshot_id = current_setting('ent.snap_a')::uuid
        AND feature_key = 'feature_b'
    ),
    10.00::numeric,
    'V1 editing the package leaves the issued snapshot untouched'
  );


SELECT
  IS (
    (
      SELECT
        content_hash
      FROM
        ops.entitlement_snapshots
      WHERE
        id = current_setting('ent.snap_a')::uuid
    ),
    current_setting('ent.hash_a'),
    'V2 the content hash of an issued snapshot never changes'
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    $$update ops.entitlement_snapshots set valid_to = DATE '2030-01-01'$$,
    '42501',
    NULL,
    'V3 the authenticated role cannot update snapshots'
  );


SELECT
  throws_ok (
    $$insert into ops.entitlement_snapshots (
      customer_id, source_type, source_id, target_scope, content_hash
    ) values (
      '00000000-0000-4000-8000-0000000009c1', 'contract_item',
      '00000000-0000-4000-8000-000000000a01', 'saas_tenant',
      repeat('0', 64)
    )$$,
    '42501',
    NULL,
    'V4 the authenticated role cannot insert snapshots directly'
  );


-- 表属主也改不了：这是「证据链」三个字的实际含义。只有 REVOKE 时，一条
-- 以属主身份跑的修数脚本能静默改写一张已发出的授权凭证。
RESET ROLE;


SELECT
  throws_ok (
    $$update ops.entitlement_snapshots set valid_to = DATE '2030-01-01'
      where id = current_setting('ent.snap_a')::uuid$$,
    '23001',
    NULL,
    'V5 even the table owner cannot rewrite a snapshot'
  );


-- 同一来源、同一内容再发一次 = 幂等，不是冲突。契约 §3.5 用
-- `UNIQUE(source_type, source_id, content_hash)` 表达这件事，这里证明实现
-- 走的是「返回既有那张」而不是「报唯一约束冲突」。
SELECT
  IS (
    ops.create_snapshot (
      '00000000-0000-4000-8000-0000000009c1',
      'contract_item',
      '00000000-0000-4000-8000-000000000a01',
      'saas_tenant',
      NULL,
      DATE '2026-01-01',
      DATE '2027-12-31',
      ops.snapshot_lines_json (current_setting('ent.snap_a')::uuid)
    ),
    current_setting('ent.snap_a')::uuid,
    'V6 reissuing identical content returns the same snapshot'
  );


UPDATE ops.feature_definitions
SET
  display_name = '基础功能（改名）'
WHERE
  feature_key = 'feature_a';


SELECT
  IS (
    ops.create_snapshot (
      '00000000-0000-4000-8000-0000000009c1',
      'contract_item',
      '00000000-0000-4000-8000-000000000a01',
      'saas_tenant',
      NULL,
      DATE '2026-01-01',
      DATE '2027-12-31',
      ops.feature_lines_apply (
        ops.snapshot_lines_json (current_setting('ent.snap_a')::uuid),
        NULL
      ) -> 'lines'
    ),
    current_setting('ent.snap_a')::uuid,
    'V7 a renamed feature does not mint a new snapshot'
  );


-- ── G：列表与详情 ──────────────────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000009b4","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    ops.list_subscriptions (
      p_customer_id => '00000000-0000-4000-8000-0000000009c1'
    ) ->> 'total',
    '3',
    'G1 the subscription list filters by customer'
  );


SELECT
  IS (
    ops.list_subscriptions (p_statuses => ARRAY['revoked']) ->> 'total',
    '1',
    'G2 the status filter accepts an array'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.get_subscription (current_setting('ent.sub_a')::uuid) -> 'change_requests'
    ),
    '2',
    'G3 the detail carries the change request history'
  );


SELECT
  IS (
    ops.list_licenses (p_expiring_in_days => 30) ->> 'total',
    '1',
    'G4 expiringSoon excludes perpetual licenses'
  );


SELECT
  IS (
    ops.list_entitlement_snapshots (
      p_subject_type => 'subscription',
      p_subject_id => current_setting('ent.sub_a')::uuid
    ) ->> 'total',
    '3',
    'G5 the snapshot list returns the first issuance and every change'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.get_entitlement_snapshot (current_setting('ent.snap_a')::uuid) -> 'lines'
    ),
    '3',
    'G6 the snapshot detail returns its lines'
  );


-- ── U：审计 ────────────────────────────────────────────────────────────────
RESET ROLE;


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events
      WHERE
        action = 'subscription.created'
        AND entity_id = current_setting('ent.sub_a')::uuid
        AND actor_operator_id = '00000000-0000-4000-8000-0000000009a1'
    ),
    'U1 subscription creation is audited with the actor'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events
      WHERE
        action = 'entitlement_change.approved'
        AND entity_id = current_setting('ent.cr_a')::uuid
    ),
    'U2 change request approval is audited'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events
      WHERE
        action = 'entitlement_snapshot.created'
        AND entity_id = current_setting('ent.snap_a')::uuid
    ),
    'U3 snapshot issuance is audited'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;