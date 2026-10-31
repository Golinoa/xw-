BEGIN;


SELECT
  plan (80);


-- ── 夹具 ────────────────────────────────────────────────────────────────────
-- 三个运营身份：交付运营（`deployment.read` + `deployment.write`）、商务运营
-- （只有 `deployment.read`）、无角色（连 read 都没有）。本域的分界线就在
-- 「能不能登台账」与「能不能推进状态」之间，所以必须有两个都算运营却权限不同的
-- 身份，只测「有权限通过 / 无权限 403」证不出这条线。
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-0000000008b1',
    'authenticated',
    'authenticated',
    'deploy-delivery@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000008b2',
    'authenticated',
    'authenticated',
    'deploy-sales@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000008b3',
    'authenticated',
    'authenticated',
    'deploy-norole@example.test'
  );


INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000008a1',
    '00000000-0000-4000-8000-0000000008b1',
    'deploy-delivery@example.test',
    'deploy 交付',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000008a2',
    '00000000-0000-4000-8000-0000000008b2',
    'deploy-sales@example.test',
    'deploy 商务',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000008a3',
    '00000000-0000-4000-8000-0000000008b3',
    'deploy-norole@example.test',
    'deploy 无角色',
    'active'
  );


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  fixture.operator_id,
  role.id,
  fixture.operator_id
FROM
  (
    VALUES
      (
        '00000000-0000-4000-8000-0000000008a1'::uuid,
        'delivery_ops'
      ),
      (
        '00000000-0000-4000-8000-0000000008a2'::uuid,
        'sales_ops'
      )
  ) AS fixture (operator_id, role_code)
  JOIN ops.roles AS role ON role.code = fixture.role_code;


INSERT INTO
  ops.customers (id, name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000008c1',
    'deploy 测试客户甲',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000008c2',
    'deploy 测试客户乙',
    'active'
  );


INSERT INTO
  ops.products (id, code, name, lifecycle_status)
VALUES
  (
    '00000000-0000-4000-8000-0000000008e1',
    'PRD-DEP',
    'deploy 测试产品',
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
    '00000000-0000-4000-8000-0000000008e2',
    '00000000-0000-4000-8000-0000000008e1',
    '私有版',
    '私有版',
    'private',
    'fixed_term',
    200000.00,
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
    '00000000-0000-4000-8000-0000000008d1',
    '00000000-0000-4000-8000-0000000008c1',
    'private',
    'active',
    200000.00,
    'CNY',
    DATE '2026-01-01'
  ),
  (
    '00000000-0000-4000-8000-0000000008d2',
    '00000000-0000-4000-8000-0000000008c2',
    'private',
    'active',
    200000.00,
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
    '00000000-0000-4000-8000-0000000008d3',
    '00000000-0000-4000-8000-0000000008d1',
    '00000000-0000-4000-8000-0000000008e1',
    '00000000-0000-4000-8000-0000000008e2',
    'private',
    'fixed_term',
    1,
    200000.00,
    200000.00,
    '私有版',
    1
  ),
  (
    '00000000-0000-4000-8000-0000000008d4',
    '00000000-0000-4000-8000-0000000008d2',
    '00000000-0000-4000-8000-0000000008e1',
    '00000000-0000-4000-8000-0000000008e2',
    'private',
    'fixed_term',
    1,
    200000.00,
    200000.00,
    '私有版',
    1
  );


-- 主实例直插而不是走 RPC：它要预先挂上授权与工单，而这两件事都要属主身份。
-- `current_version` 留空是刻意的——R 组的「第一条记录就是基线」（设计要点 3）
-- 用的就是这一台。
INSERT INTO
  ops.deployment_instances (
    id,
    instance_no,
    customer_id,
    name,
    deployment_type,
    current_version,
    status,
    maintenance_until
  )
VALUES
  (
    '00000000-0000-4000-8000-000000008111',
    'DEP-900001',
    '00000000-0000-4000-8000-0000000008c1',
    '甲客户主实例',
    'private',
    NULL,
    'planned',
    DATE '2027-01-31'
  );


-- 两张授权分属两个客户：`create_deployment_instance` 的跨客户校验（A9）与
-- 同一客户通过的情况都要有真实行才测得到。
INSERT INTO
  ops.private_licenses (
    id,
    customer_id,
    contract_id,
    contract_item_id,
    deployment_instance_id,
    license_mode,
    valid_from,
    status
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000008f1',
    '00000000-0000-4000-8000-0000000008c1',
    '00000000-0000-4000-8000-0000000008d1',
    '00000000-0000-4000-8000-0000000008d3',
    '00000000-0000-4000-8000-000000008111',
    'perpetual',
    DATE '2026-01-01',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000008f2',
    '00000000-0000-4000-8000-0000000008c2',
    '00000000-0000-4000-8000-0000000008d2',
    '00000000-0000-4000-8000-0000000008d4',
    NULL,
    'perpetual',
    DATE '2026-01-01',
    'active'
  );


INSERT INTO
  ops.tickets (
    id,
    ticket_no,
    customer_id,
    deployment_instance_id,
    subject,
    description,
    issue_type,
    priority,
    status
  )
VALUES
  (
    '00000000-0000-4000-8000-000000008121',
    'TK-900001',
    '00000000-0000-4000-8000-0000000008c1',
    '00000000-0000-4000-8000-000000008111',
    '升级后登录异常',
    '升级到 1.5.0 之后三个账号登不上',
    'bug',
    'high',
    'new'
  );


-- ── 切到交付运营身份，走写入路径 ────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000008b1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


-- ── A：建实例 ───────────────────────────────────────────────────────────────
-- 建实例需要 `deployment.write`（交付运营有），状态恒为 planned。
SELECT
  set_config(
    'dep.created',
    ops.create_deployment_instance (
      '00000000-0000-4000-8000-0000000008c1',
      '甲客户灾备实例',
      'dedicated',
      'bj-dr-01',
      '1.4.0',
      DATE '2026-11-01',
      DATE '2027-11-01',
      '00000000-0000-4000-8000-0000000008a2',
      NULL,
      '00000000-0000-4000-8000-0000000008d1'
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('dep.created')::jsonb #>> '{status}',
    'ok',
    'A1 delivery_ops can register an instance'
  );


SELECT
  IS (
    current_setting('dep.created')::jsonb #>> '{deployment,status}',
    'planned',
    'A2 a new instance is always planned'
  );


SELECT
  matches (
    current_setting('dep.created')::jsonb #>> '{deployment,instance_no}',
    '^DEP-[0-9]{6}$',
    'A3 instance_no comes from the DEP- sequence'
  );


SELECT
  IS (
    current_setting('dep.created')::jsonb #>> '{deployment,owner,id}',
    '00000000-0000-4000-8000-0000000008a2',
    'A4 the owner comes back as a summary, not just an id'
  );


SELECT
  IS (
    ops.create_deployment_instance (
      '00000000-0000-4000-8000-0000000008c1',
      '   ',
      'private'
    ) ->> 'status',
    'name_required',
    'A5 a blank name is not a name'
  );


SELECT
  IS (
    ops.create_deployment_instance (
      '00000000-0000-4000-8000-0000000008c1',
      '类型错',
      'on_premise'
    ) ->> 'status',
    'invalid_deployment_type',
    'A6 deployment_type only accepts private / dedicated'
  );


SELECT
  IS (
    ops.create_deployment_instance (
      '00000000-0000-4000-8000-0000000008ff',
      '客户不存在',
      'private'
    ) ->> 'status',
    'customer_not_found',
    'A7 a deployment must belong to a real customer'
  );


-- `UNIQUE(customer_id, name)`：同名会让工单里的实例下拉出现两个一样的选项。
SELECT
  IS (
    ops.create_deployment_instance (
      '00000000-0000-4000-8000-0000000008c1',
      '甲客户主实例',
      'private'
    ) ->> 'status',
    'name_taken',
    'A8 the same customer cannot have two instances with one name'
  );


-- 授权必须属于同一个客户：拿乙客户的授权给甲客户的机器上线，之后按客户算
-- 「已授权未部署 / 已部署未授权」两张表都会算错。
SELECT
  IS (
    ops.create_deployment_instance (
      '00000000-0000-4000-8000-0000000008c1',
      '借来的授权',
      'private',
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      '00000000-0000-4000-8000-0000000008f2'
    ) ->> 'status',
    'license_customer_mismatch',
    'A9 a license from another customer is refused'
  );


SELECT
  IS (
    ops.create_deployment_instance (
      '00000000-0000-4000-8000-0000000008c1',
      '借来的合同',
      'private',
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      '00000000-0000-4000-8000-0000000008d2'
    ) ->> 'status',
    'contract_customer_mismatch',
    'A10 a contract from another customer is refused'
  );


SELECT
  IS (
    ops.create_deployment_instance (
      '00000000-0000-4000-8000-0000000008c1',
      '授权不存在',
      'private',
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      '00000000-0000-4000-8000-0000000008ff'
    ) ->> 'status',
    'license_not_found',
    'A11 an unknown license id is a body error, not a 404 on the customer'
  );


-- ── P：权限 ─────────────────────────────────────────────────────────────────
-- 商务运营有 `deployment.read` 没有 write：能登台账、不能推状态。只测「无权限
-- 403」证不出这条线——那是「没有 read」而不是「没有 write」。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000008b2","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    ops.list_deployment_instances () ->> 'status',
    'ok',
    'P1 sales_ops can read the ledger'
  );


SELECT
  throws_ok (
    $$select ops.create_deployment_instance ('00000000-0000-4000-8000-0000000008c1', '销售建的', 'private')$$,
    '42501',
    NULL,
    'P2 sales_ops cannot register an instance'
  );


SELECT
  throws_ok (
    $$select ops.transition_deployment_instance ('00000000-0000-4000-8000-000000008111', 'go_live', NULL, DATE '2026-11-01', 0)$$,
    '42501',
    NULL,
    'P3 sales_ops cannot push the state machine'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000008b3","role":"authenticated"}',
    TRUE
  );


SELECT
  throws_ok (
    $$select ops.list_deployment_instances ()$$,
    '42501',
    NULL,
    'P4 an operator without any role cannot even read'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000008b1","role":"authenticated"}',
    TRUE
  );


-- ── X：改实例（PATCH 的 jsonb 补丁）────────────────────────────────────────────────────────
-- 主实例此刻 `version = 0`。改一个字段之后必须变 1，并且审计里只有那一个键。
SELECT
  set_config(
    'dep.patched',
    ops.update_deployment_instance (
      '00000000-0000-4000-8000-000000008111',
      jsonb_build_object('environmentRef', 'bj-prod-01'),
      0
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('dep.patched')::jsonb #>> '{deployment,environment_ref}',
    'bj-prod-01',
    'X1 PATCH writes the field it was given'
  );


SELECT
  IS (
    (
      current_setting('dep.patched')::jsonb #>> '{deployment,version}'
    )::integer,
    1,
    'X2 PATCH bumps the optimistic-lock version'
  );


-- 空补丁不该写：一次什么都没改的「保存」也把 version 推一格，会让两端无故失配。
SELECT
  IS (
    (
      ops.update_deployment_instance (
        '00000000-0000-4000-8000-000000008111',
        '{}'::jsonb,
        1
      ) ->> 'version'
    ),
    NULL,
    'X3 an empty patch is not a change'
  );


SELECT
  IS (
    (
      ops.update_deployment_instance (
        '00000000-0000-4000-8000-000000008111',
        '{}'::jsonb,
        1
      ) #>> '{deployment,version}'
    )::integer,
    1,
    'X4 an empty patch leaves the version alone'
  );


-- `currentVersion` 不在可编辑集合里（设计要点 2）：补丁里带着它也不会生效，
-- 否则「登记升级」这条唯一的推进路径可以被一次 PATCH 绕过。
SELECT
  IS (
    (
      ops.update_deployment_instance (
        '00000000-0000-4000-8000-000000008111',
        jsonb_build_object('currentVersion', '9.9.9'),
        1
      ) #>> '{deployment,current_version}'
    ),
    NULL,
    'X5 currentVersion cannot be patched — only a succeeded upgrade moves it'
  );


SELECT
  IS (
    (
      ops.update_deployment_instance (
        '00000000-0000-4000-8000-000000008111',
        jsonb_build_object('name', '甲客户主实例'),
        1
      ) #>> '{deployment,version}'
    )::integer,
    1,
    'X6 patching a field to its current value changes nothing'
  );


SELECT
  IS (
    ops.update_deployment_instance (
      '00000000-0000-4000-8000-000000008111',
      jsonb_build_object('name', '乙客户主实例'),
      0
    ) ->> 'status',
    'version_mismatch',
    'X7 a stale version is refused, not silently applied'
  );


SELECT
  IS (
    ops.update_deployment_instance (
      '00000000-0000-4000-8000-0000000008ff',
      jsonb_build_object('name', 'x'),
      0
    ) ->> 'status',
    'not_found',
    'X8 patching an unknown instance is not_found'
  );


-- ── T：状态机 ───────────────────────────────────────────────────────────────
SELECT
  IS (
    ops.transition_deployment_instance (
      '00000000-0000-4000-8000-000000008111',
      'go_live',
      NULL,
      NULL,
      1
    ) ->> 'status',
    'go_live_on_required',
    'T1 go_live without a go-live date is a body error'
  );


SELECT
  set_config(
    'dep.live',
    ops.transition_deployment_instance (
      '00000000-0000-4000-8000-000000008111',
      'go_live',
      '客户验收通过',
      DATE '2026-11-01',
      1
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('dep.live')::jsonb #>> '{deployment,status}',
    'active',
    'T2 go_live moves planned to active'
  );


SELECT
  IS (
    current_setting('dep.live')::jsonb #>> '{deployment,go_live_on}',
    '2026-11-01',
    'T3 the go-live date is recorded'
  );


SELECT
  IS (
    current_setting('dep.live')::jsonb -> 'allowed_actions',
    '["start_maintenance", "retire"]'::jsonb,
    'T4 active allows exactly start_maintenance and retire'
  );


SELECT
  IS (
    (
      ops.transition_deployment_instance (
        '00000000-0000-4000-8000-000000008111',
        'go_live',
        NULL,
        DATE '2026-11-02',
        2
      )
    ) ->> 'status',
    'invalid_transition',
    'T5 an edge the state machine does not have is refused'
  );


SELECT
  IS (
    (
      ops.transition_deployment_instance (
        '00000000-0000-4000-8000-000000008111',
        'go_live',
        NULL,
        DATE '2026-11-02',
        2
      )
    ) -> 'allowed_actions',
    '["start_maintenance", "retire"]'::jsonb,
    'T6 a refused transition still tells the caller what is allowed'
  );


SELECT
  set_config(
    'dep.maintenance',
    ops.transition_deployment_instance (
      '00000000-0000-4000-8000-000000008111',
      'start_maintenance',
      '等待客户侧变更窗口',
      NULL,
      2
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('dep.maintenance')::jsonb #>> '{deployment,status}',
    'maintenance',
    'T7 start_maintenance moves active to maintenance'
  );


SELECT
  IS (
    current_setting('dep.maintenance')::jsonb -> 'allowed_actions',
    '["end_maintenance", "retire"]'::jsonb,
    'T8 maintenance allows exactly end_maintenance and retire'
  );


SELECT
  IS (
    (
      ops.transition_deployment_instance (
        '00000000-0000-4000-8000-000000008111',
        'end_maintenance',
        NULL,
        NULL,
        3
      )
    ) #>> '{deployment,status}',
    'active',
    'T9 end_maintenance goes back to active'
  );


SELECT
  IS (
    ops.transition_deployment_instance (
      '00000000-0000-4000-8000-000000008111',
      'retire',
      '   ',
      NULL,
      4
    ) ->> 'status',
    'reason_required',
    'T10 retire without a reason is refused'
  );


SELECT
  IS (
    ops.transition_deployment_instance (
      '00000000-0000-4000-8000-000000008111',
      'retire',
      '客户退租',
      NULL,
      4
    ) #>> '{deployment,status}',
    'retired',
    'T11 retire terminates the instance'
  );


-- 退役是终态：重新上线是**另一台实例**（换机器、换授权），把同一行改回 active
-- 会让两段互不相关的历史接在一起。
SELECT
  IS (
    ops.transition_deployment_instance (
      '00000000-0000-4000-8000-000000008111',
      'go_live',
      NULL,
      DATE '2026-12-01',
      5
    ) ->> 'status',
    'invalid_transition',
    'T12 retired is a terminal state'
  );


SELECT
  IS (
    ops.update_deployment_instance (
      '00000000-0000-4000-8000-000000008111',
      jsonb_build_object('name', '退役之后改个名'),
      5
    ) ->> 'status',
    'instance_retired',
    'T13 a retired instance cannot be edited any more'
  );


SELECT
  IS (
    ops.transition_deployment_instance (
      '00000000-0000-4000-8000-000000008111',
      'retire',
      '客户退租',
      NULL,
      4
    ) ->> 'status',
    'version_mismatch',
    'T14 a stale version is refused before the state machine is consulted'
  );


-- ── R：升级记录 ─────────────────────────────────────────────────────────────
-- 第二台实例，专验升级台账：新建时没有 `currentVersion`，所以第一条记录就是
-- 基线（设计要点 3）。`deployment_type` 用 dedicated，供 G 组筛选用。
SELECT
  set_config(
    'dep.second',
    ops.create_deployment_instance (
      '00000000-0000-4000-8000-0000000008c2',
      '乙客户生产实例',
      'dedicated'
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('dep.second')::jsonb #>> '{deployment,current_version}',
    NULL,
    'R1 an instance can be registered before its version is known'
  );


SELECT
  IS (
    current_setting('dep.second')::jsonb #>> '{deployment,last_reported_at}',
    NULL,
    'R2 last reported at is derived and null while there is no upgrade record'
  );


SELECT
  set_config(
    'dep.base',
    ops.create_deployment_version_record (
      (
        current_setting('dep.second')::jsonb #>> '{deployment,id}'
      )::uuid,
      '1.0.0',
      '1.0.0',
      DATE '2026-10-01',
      'succeeded',
      '初始安装'
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('dep.base')::jsonb #>> '{version_record,result}',
    'succeeded',
    'R3 the first record on an instance without a baseline is accepted'
  );


SELECT
  IS (
    current_setting('dep.base')::jsonb #>> '{deployment,current_version}',
    '1.0.0',
    'R4 a succeeded record establishes the baseline'
  );


SELECT
  IS (
    current_setting('dep.base')::jsonb #>> '{version_record,executed_by,id}',
    '00000000-0000-4000-8000-0000000008a1',
    'R5 executed_by is the session operator, not an input'
  );


SELECT
  ok (
    current_setting('dep.base')::jsonb #>> '{deployment,last_reported_at}' IS NOT NULL,
    'R6 the last reported time is derived from the newest upgrade record'
  );


SELECT
  set_config(
    'dep.failed',
    ops.create_deployment_version_record (
      (
        current_setting('dep.second')::jsonb #>> '{deployment,id}'
      )::uuid,
      '1.0.0',
      '1.1.0',
      DATE '2026-10-10',
      'failed',
      NULL,
      '回滚脚本未执行'
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('dep.failed')::jsonb #>> '{version_record,result}',
    'failed',
    'R7 a failed upgrade is recorded'
  );


-- D-07：只有 succeeded 推进当前版本。失败回写会让「这台机器跑的是 1.0.0」
-- 变成一句没有依据的话，而维护到期、授权关联、工单引用全都读这一列。
SELECT
  IS (
    current_setting('dep.failed')::jsonb #>> '{deployment,current_version}',
    '1.0.0',
    'R8 a failed upgrade does not move the current version'
  );


-- `from_version` 必须等于当前版本，所以一条 `rolled_back` 记录读作「本来在
-- 1.0.0，想升到 1.1.0，回滚了，还在 1.0.0」——回滚成功的定义就是没动位置。
SELECT
  IS (
    (
      ops.create_deployment_version_record (
        (
          current_setting('dep.second')::jsonb #>> '{deployment,id}'
        )::uuid,
        '1.0.0',
        '1.1.0',
        DATE '2026-10-11',
        'rolled_back',
        NULL,
        '切回上一版'
      )
    ) #>> '{version_record,result}',
    'rolled_back',
    'R9 a rolled back upgrade is recorded'
  );


SELECT
  IS (
    (
      ops.create_deployment_version_record (
        (
          current_setting('dep.second')::jsonb #>> '{deployment,id}'
        )::uuid,
        '1.0.0',
        '1.5.0',
        DATE '2026-10-12',
        'succeeded'
      )
    ) #>> '{deployment,current_version}',
    '1.5.0',
    'R10 a succeeded upgrade moves the current version'
  );


-- T-11 唯一一条拒绝断言：from_version 与当前版本不符。
SELECT
  IS (
    ops.create_deployment_version_record (
      (
        current_setting('dep.second')::jsonb #>> '{deployment,id}'
      )::uuid,
      '1.4.0',
      '1.6.0',
      DATE '2026-10-13',
      'succeeded'
    ) ->> 'status',
    'version_mismatch',
    'R11 from_version must match the current version'
  );


SELECT
  IS (
    (
      ops.create_deployment_version_record (
        (
          current_setting('dep.second')::jsonb #>> '{deployment,id}'
        )::uuid,
        '1.4.0',
        '1.6.0',
        DATE '2026-10-13',
        'succeeded'
      )
    ) #>> '{current_version}',
    '1.5.0',
    'R12 the refusal reports the version the caller should have sent'
  );


SELECT
  IS (
    ops.create_deployment_version_record (
      (
        current_setting('dep.second')::jsonb #>> '{deployment,id}'
      )::uuid,
      '1.5.0',
      '   ',
      DATE '2026-10-13',
      'succeeded'
    ) ->> 'status',
    'to_version_required',
    'R13 the target version cannot be blank'
  );


SELECT
  IS (
    ops.create_deployment_version_record (
      (
        current_setting('dep.second')::jsonb #>> '{deployment,id}'
      )::uuid,
      '1.5.0',
      '1.6.0',
      DATE '2026-10-13',
      'partial'
    ) ->> 'status',
    'invalid_result',
    'R14 result only accepts succeeded / failed / rolled_back'
  );


SELECT
  IS (
    ops.create_deployment_version_record (
      (
        current_setting('dep.second')::jsonb #>> '{deployment,id}'
      )::uuid,
      '1.5.0',
      '1.6.0',
      NULL,
      'succeeded'
    ) ->> 'status',
    'executed_on_required',
    'R15 the execution date is required'
  );


SELECT
  IS (
    ops.create_deployment_version_record (
      '00000000-0000-4000-8000-0000000008ff',
      '1.0.0',
      '1.1.0',
      DATE '2026-10-13',
      'succeeded'
    ) ->> 'status',
    'not_found',
    'R16 recording against an unknown instance is not_found'
  );


-- 升级记录只 INSERT（契约 §3.7）。REVOKE 挡的是业务身份，挡不住表属主——
-- 而「这次升级其实失败了」被改成成功，等于把 current_version 的依据抹掉。
RESET ROLE;


SELECT
  throws_ok (
    $$update ops.deployment_version_records set to_version = '9.9.9'$$,
    '23001',
    NULL,
    'R17 upgrade records are append-only even for the table owner (update)'
  );


SELECT
  throws_ok (
    $$delete from ops.deployment_version_records$$,
    '23001',
    NULL,
    'R18 upgrade records are append-only even for the table owner (delete)'
  );


SET
  local role authenticated;


-- ── G：列表与筛选 ───────────────────────────────────────────────────────────
SELECT
  IS (
    (
      ops.list_deployment_instances ('00000000-0000-4000-8000-0000000008c2')
    ) #>> '{total}',
    '1',
    'G1 filtering by customer returns only that customer''s instances'
  );


SELECT
  IS (
    (
      ops.list_deployment_instances (NULL, ARRAY['planned'])
    ) #>> '{total}',
    '2',
    'G2 both instances that were never put live are still planned'
  );


SELECT
  IS (
    (
      ops.list_deployment_instances (NULL, NULL, 'dedicated')
    ) #>> '{total}',
    '2',
    'G3 filtering by deployment_type keeps both dedicated instances'
  );


-- 「维护到期日早于某天」是运营端最常用的一问（到期前 30 天要提前续）。
-- 没有维护到期日的实例不进结果集——它没有「快到期」这件事。
SELECT
  IS (
    (
      ops.list_deployment_instances (NULL, NULL, NULL, NULL, DATE '2027-02-01')
    ) #>> '{total}',
    '1',
    'G4 maintenance_until_before excludes instances without a maintenance date'
  );


SELECT
  IS (
    (
      ops.list_deployment_instances (NULL, NULL, NULL, NULL, DATE '2026-12-01')
    ) #>> '{total}',
    '0',
    'G5 an instance whose maintenance ends later is not "about to expire"'
  );


SELECT
  IS (
    (
      ops.list_deployment_instances (NULL, NULL, NULL, NULL, NULL, 15, 0)
    ) #>> '{total}',
    '3',
    'G6 total counts every match, not just the page'
  );


-- ── V：详情 ─────────────────────────────────────────────────────────────────
SELECT
  set_config(
    'dep.detail',
    ops.get_deployment_instance (
      (
        current_setting('dep.second')::jsonb #>> '{deployment,id}'
      )::uuid
    )::text,
    TRUE
  );


SELECT
  IS (
    jsonb_array_length(
      current_setting('dep.detail')::jsonb -> 'versionRecords'
    ),
    4,
    'V1 the detail carries the whole upgrade history'
  );


SELECT
  IS (
    current_setting('dep.detail')::jsonb #>> '{versionRecords,0,to_version}',
    '1.5.0',
    'V2 the history is newest first'
  );


SELECT
  IS (
    (
      ops.get_deployment_instance ('00000000-0000-4000-8000-000000008111')
    ) #>> '{licenses,0,id}',
    '00000000-0000-4000-8000-0000000008f1',
    'V3 licenses[] comes from the license side of the relation'
  );


SELECT
  IS (
    (
      ops.get_deployment_instance ('00000000-0000-4000-8000-000000008111')
    ) #>> '{tickets,0,ticket_no}',
    'TK-900001',
    'V4 tickets[] lists the tickets that point at this instance'
  );


SELECT
  IS (
    (
      ops.get_deployment_instance ('00000000-0000-4000-8000-000000008111')
    ) ->> 'allowedActions',
    NULL,
    'V5 allowed_actions is at the envelope level, not inside the deployment'
  );


SELECT
  IS (
    (
      ops.get_deployment_instance ('00000000-0000-4000-8000-000000008111')
    ) -> 'allowed_actions',
    '[]'::jsonb,
    'V6 a retired instance allows nothing'
  );


SELECT
  IS (
    ops.get_deployment_instance ('00000000-0000-4000-8000-0000000008ff') ->> 'status',
    'not_found',
    'V7 an unknown instance is not_found'
  );


SELECT
  IS (
    (
      ops.list_deployment_version_records ('00000000-0000-4000-8000-0000000008ff')
    ) ->> 'status',
    'not_found',
    'V8 an unknown instance is 404 even for its (empty) record list'
  );


SELECT
  IS (
    (
      ops.list_deployment_version_records (
        (
          current_setting('dep.second')::jsonb #>> '{deployment,id}'
        )::uuid,
        2,
        0
      )
    ) #>> '{total}',
    '4',
    'V9 the record list counts the whole history'
  );


SELECT
  IS (
    jsonb_array_length(
      (
        ops.list_deployment_version_records (
          (
            current_setting('dep.second')::jsonb #>> '{deployment,id}'
          )::uuid,
          2,
          0
        )
      ) -> 'items'
    ),
    2,
    'V10 the page size is honoured'
  );


-- ── W：禁止列白名单（PRD §6.8 / §10.2）────────────────────────────────────
-- 不是代码评审看一眼，是可执行的断言：本域两张表里不得出现任何凭据类列。
--
-- 这两组要回到属主身份：`information_schema.columns` 与 `ops.audit_events` 都
-- 按当前角色的权限过滤，`authenticated` 看过去是空的——空结果会让「没有凭据列」
-- 与「什么都看不见」得到同一条绿。这是白名单类断言最容易骗过自己的一处。
RESET ROLE;


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        information_schema.columns AS column_entry
      WHERE
        column_entry.table_schema = 'ops'
        AND column_entry.table_name IN (
          'deployment_instances',
          'deployment_version_records'
        )
        AND (
          column_entry.column_name LIKE '%password%'
          OR column_entry.column_name LIKE 'ssh\_%'
          OR column_entry.column_name IN (
            'admin_token',
            'connection_string',
            'install_package_url'
          )
        )
    ),
    0::bigint,
    'W1 no credential-looking column exists in the deployment tables'
  );


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        information_schema.columns AS column_entry
      WHERE
        column_entry.table_schema = 'ops'
        AND column_entry.table_name = 'deployment_instances'
        AND column_entry.column_name = 'environment_ref'
    ),
    1::bigint,
    'W2 the environment is referenced by name, not by a connection string'
  );


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        information_schema.columns AS column_entry
      WHERE
        column_entry.table_schema = 'ops'
        AND column_entry.table_name = 'deployment_instances'
        AND column_entry.column_name = 'last_reported_at'
    ),
    0::bigint,
    'W3 there is no heartbeat column — the last report is derived (D-04)'
  );


-- ── U：审计 ─────────────────────────────────────────────────────────────────
SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'deployment.created'
    ),
    2::bigint,
    'U1 two instances were registered, two audit events'
  );


SELECT
  IS (
    (
      SELECT
        event.after_summary
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'deployment.updated'
      ORDER BY
        event.created_at DESC
      LIMIT
        1
    ),
    '{"environmentRef": "bj-prod-01"}'::jsonb,
    'U2 the update audit carries only the keys that changed'
  );


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'deployment.transitioned'
        AND event.reason = '客户退租'
    ),
    1::bigint,
    'U3 the retire reason lands in the audit, not in a column'
  );


SELECT
  IS (
    (
      SELECT
        count(*)
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'deployment_version.recorded'
    ),
    4::bigint,
    'U4 every upgrade record writes one audit event'
  );


SELECT
  IS (
    (
      SELECT
        event.after_summary ->> 'currentVersion'
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'deployment_version.recorded'
        AND event.after_summary ->> 'result' = 'failed'
    ),
    '1.0.0',
    'U5 a failed upgrade audits the version that did not change'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000008b2","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


-- 商务运营能读到的与交付运营一模一样：读侧不因写权限而分叉，否则「谁都能看
-- 台账」这句话在每个角色上都要重验一次。
SELECT
  IS (
    (
      ops.get_deployment_instance (
        (
          current_setting('dep.second')::jsonb #>> '{deployment,id}'
        )::uuid
      )
    ) #>> '{deployment,current_version}',
    '1.5.0',
    'U6 read access does not depend on write access'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;