BEGIN;


SELECT
  plan (69);


-- ── 夹具 ────────────────────────────────────────────────────────────────────
-- 五个身份，分权同样是刻意的：
--   A 只能 provision（**没有 tenant.retry**，用来证明重试要两个动作码）
--   B 只能 suspend（用来证明「按 commandType 判权限」：建 suspend 通过、
--     建 sync_entitlement 被 42501 挡住）
--   C 是交付角色，tenant.* 与 entitlement.execute 全有
--   D 只读（tenant.read）
--   E 无角色
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-0000000008b1',
    'authenticated',
    'authenticated',
    'tenant-provisioner@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000008b2',
    'authenticated',
    'authenticated',
    'tenant-suspender@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000008b3',
    'authenticated',
    'authenticated',
    'tenant-delivery@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000008b4',
    'authenticated',
    'authenticated',
    'tenant-viewer@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000008b5',
    'authenticated',
    'authenticated',
    'tenant-norole@example.test'
  );


INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000008a1',
    '00000000-0000-4000-8000-0000000008b1',
    'tenant-provisioner@example.test',
    '交付开通',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000008a2',
    '00000000-0000-4000-8000-0000000008b2',
    'tenant-suspender@example.test',
    '交付停服',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000008a3',
    '00000000-0000-4000-8000-0000000008b3',
    'tenant-delivery@example.test',
    '交付主管',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000008a4',
    '00000000-0000-4000-8000-0000000008b4',
    'tenant-viewer@example.test',
    '交付只读',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000008a5',
    '00000000-0000-4000-8000-0000000008b5',
    'tenant-norole@example.test',
    '交付无角色',
    'active'
  );


INSERT INTO
  ops.roles (id, code, name)
VALUES
  (
    '00000000-0000-4000-8000-000000000881',
    'tenant_test_provision',
    '租户开通（测试）'
  ),
  (
    '00000000-0000-4000-8000-000000000882',
    'tenant_test_suspend',
    '租户停服（测试）'
  ),
  (
    '00000000-0000-4000-8000-000000000883',
    'tenant_test_delivery',
    '租户交付（测试）'
  ),
  (
    '00000000-0000-4000-8000-000000000884',
    'tenant_test_view',
    '租户只读（测试）'
  );


INSERT INTO
  ops.role_permissions (role_id, permission_code)
VALUES
  (
    '00000000-0000-4000-8000-000000000881',
    'tenant.read'
  ),
  (
    '00000000-0000-4000-8000-000000000881',
    'tenant.provision'
  ),
  (
    '00000000-0000-4000-8000-000000000882',
    'tenant.read'
  ),
  (
    '00000000-0000-4000-8000-000000000882',
    'tenant.suspend'
  ),
  (
    '00000000-0000-4000-8000-000000000883',
    'tenant.read'
  ),
  (
    '00000000-0000-4000-8000-000000000883',
    'tenant.provision'
  ),
  (
    '00000000-0000-4000-8000-000000000883',
    'tenant.suspend'
  ),
  (
    '00000000-0000-4000-8000-000000000883',
    'tenant.restore'
  ),
  (
    '00000000-0000-4000-8000-000000000883',
    'tenant.retry'
  ),
  (
    '00000000-0000-4000-8000-000000000883',
    'entitlement.execute'
  ),
  (
    '00000000-0000-4000-8000-000000000884',
    'tenant.read'
  ),
  (
    '00000000-0000-4000-8000-000000000881',
    'entitlement.read'
  );


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
VALUES
  (
    '00000000-0000-4000-8000-0000000008a1',
    '00000000-0000-4000-8000-000000000881',
    '00000000-0000-4000-8000-0000000008a1'
  ),
  (
    '00000000-0000-4000-8000-0000000008a2',
    '00000000-0000-4000-8000-000000000882',
    '00000000-0000-4000-8000-0000000008a2'
  ),
  (
    '00000000-0000-4000-8000-0000000008a3',
    '00000000-0000-4000-8000-000000000883',
    '00000000-0000-4000-8000-0000000008a3'
  ),
  (
    '00000000-0000-4000-8000-0000000008a4',
    '00000000-0000-4000-8000-000000000884',
    '00000000-0000-4000-8000-0000000008a4'
  );


INSERT INTO
  ops.customers (id, name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000008c1',
    '租户测试客户甲',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000008c2',
    '租户测试客户乙',
    'active'
  );


INSERT INTO
  ops.products (id, code, name, lifecycle_status)
VALUES
  (
    '00000000-0000-4000-8000-0000000008e1',
    'PRD-TENANT',
    '租户测试产品',
    'active'
  );


-- 一张待审批的变更单：用来证明「关联变更申请必须 approved」那条守卫。
INSERT INTO
  ops.entitlement_change_requests (
    id,
    subject_type,
    subject_id,
    change_type,
    status,
    reason,
    before_summary,
    after_summary
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000008f1',
    'subscription',
    '00000000-0000-4000-8000-0000000008f2',
    'quota_change',
    'pending_approval',
    '待审批的变更',
    '{"lines":[]}'::jsonb,
    '{"lines":[]}'::jsonb
  );


SET
  local role authenticated;


-- ══ M：映射 ═════════════════════════════════════════════════════════════════
-- 两张映射：A 走完整的开通链路（创建时还没有 org id → provision → activate），
-- B 专门用来验 PATCH 与「一个租户只能指向一个客户」。合成一张的话，
-- 一旦用 PATCH 补了 org id，后面的 provision 立刻变成「重复开通」，
-- 而那不是要测的东西。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000008b1","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'tenant.map',
    ops.create_tenant_mapping (
      p_customer_id => '00000000-0000-4000-8000-0000000008c1',
      p_product_id => '00000000-0000-4000-8000-0000000008e1',
      p_external_ref => 'CRM-88',
      p_reason => '首次开通'
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('tenant.map')::jsonb #>> '{mapping,udone_organization_id}',
    NULL,
    'M1 a mapping can be created before the tenant exists, so udone_organization_id is null'
  );


SELECT
  IS (
    current_setting('tenant.map')::jsonb #>> '{mapping,mapping_status}',
    'pending',
    'M2 a new mapping starts pending'
  );


SELECT
  matches (
    current_setting('tenant.map')::jsonb #>> '{mapping,mapping_no}',
    '^TM-[0-9]{6}$',
    'M3 mapping_no is TM- plus six digits'
  );


SELECT
  set_config(
    'tenant.map2',
    ops.create_tenant_mapping (
      p_customer_id => '00000000-0000-4000-8000-0000000008c2',
      p_product_id => '00000000-0000-4000-8000-0000000008e1',
      p_reason => '第二张映射'
    )::text,
    TRUE
  );


-- pending 期间可以补外部 ID（契约 §5.7 的 PATCH）。
SELECT
  set_config(
    'tenant.patched',
    ops.update_tenant_mapping (
      p_mapping_id => (
        current_setting('tenant.map2')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_set_organization => TRUE,
      p_udone_organization_id => '00000000-0000-4000-8000-0000000008d2',
      p_version => 0,
      p_reason => '远端建好了'
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('tenant.patched')::jsonb #>> '{mapping,udone_organization_id}',
    '00000000-0000-4000-8000-0000000008d2',
    'M4 a pending mapping accepts the external organization id'
  );


SELECT
  IS (
    (
      current_setting('tenant.patched')::jsonb #>> '{mapping,version}'
    )::integer,
    1,
    'M5 a real change bumps version'
  );


SELECT
  IS (
    ops.update_tenant_mapping (
      p_mapping_id => (
        current_setting('tenant.map2')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_set_external_ref => TRUE,
      p_external_ref => 'CRM-99',
      p_version => 0
    ) ->> 'status',
    'version_mismatch',
    'M6 a stale version cannot patch the mapping'
  );


-- 契约 §3.6：一个 udone 组织只能指向一个商业客户，冲突时拒绝而不是改绑。
SELECT
  IS (
    ops.create_tenant_mapping (
      p_customer_id => '00000000-0000-4000-8000-0000000008c1',
      p_product_id => '00000000-0000-4000-8000-0000000008e1',
      p_udone_organization_id => '00000000-0000-4000-8000-0000000008d2',
      p_reason => '抢同一个租户'
    ) ->> 'status',
    'tenant_mapping_conflict',
    'M7 the same udone organization cannot be claimed by a second customer'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000008b4","role":"authenticated"}',
    TRUE
  );


SELECT
  throws_ok (
    'SELECT ops.create_tenant_mapping(p_customer_id => ''00000000-0000-4000-8000-0000000008c1'', p_product_id => ''00000000-0000-4000-8000-0000000008e1'')',
    '42501',
    NULL,
    'M8 tenant.read alone cannot create a mapping'
  );


-- ══ C：建命令 ═══════════════════════════════════════════════════════════════
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000008b1","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'tenant.cmd',
    ops.create_tenant_command (
      p_mapping_id => (
        current_setting('tenant.map')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_command_type => 'provision',
      p_reason => '开通租户',
      p_idempotency_key => 'idem-provision-1',
      p_expected_sync_version => 0,
      p_payload => '{"features":["ent_feature_a"]}'::jsonb
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('tenant.cmd')::jsonb #>> '{command,status}',
    'pending',
    'C1 a new command is pending - accepted, not done'
  );


SELECT
  matches (
    current_setting('tenant.cmd')::jsonb #>> '{command,command_no}',
    '^CMD-[0-9]{6}$',
    'C2 command_no is CMD- plus six digits'
  );


-- 幂等：同一把键重放同一件事，返回同一行（不是新建、也不是冲突）。
SELECT
  set_config(
    'tenant.replay',
    ops.create_tenant_command (
      p_mapping_id => (
        current_setting('tenant.map')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_command_type => 'provision',
      p_reason => '开通租户',
      p_idempotency_key => 'idem-provision-1',
      p_expected_sync_version => 0
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('tenant.replay')::jsonb #>> '{replayed}',
    'true',
    'C3 replaying the same key reports replayed'
  );


SELECT
  IS (
    current_setting('tenant.replay')::jsonb #>> '{command,id}',
    current_setting('tenant.cmd')::jsonb #>> '{command,id}',
    'C4 replaying the same key returns the same command id'
  );


-- 同一把键换一件事 → 冲突。幂等键标识的是「这次操作」，不是「这类操作」。
SELECT
  IS (
    ops.create_tenant_command (
      p_mapping_id => (
        current_setting('tenant.map')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_command_type => 'activate',
      p_reason => '顺手激活',
      p_idempotency_key => 'idem-provision-1',
      p_expected_sync_version => 0
    ) ->> 'status',
    'idempotency_conflict',
    'C5 the same key with a different command type is a conflict'
  );


SELECT
  IS (
    ops.create_tenant_command (
      p_mapping_id => (
        current_setting('tenant.map')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_command_type => 'activat',
      p_reason => '拼错了',
      p_idempotency_key => 'idem-typo',
      p_expected_sync_version => 0
    ) ->> 'status',
    'invalid_command_type',
    'C6 an unknown command type is refused before any permission check'
  );


-- 映射 A 还没有 org id，此时激活它等于激活一个不存在的租户。
SELECT
  IS (
    ops.create_tenant_command (
      p_mapping_id => (
        current_setting('tenant.map')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_command_type => 'activate',
      p_reason => '还没绑定就激活',
      p_idempotency_key => 'idem-activate-early',
      p_expected_sync_version => 0
    ) ->> 'status',
    'mapping_not_bound',
    'C7 a mapping without an organization cannot be activated'
  );


-- 映射 B 已经被 PATCH 补上 org id 了，所以再发 provision 是重复开通。
SELECT
  IS (
    ops.create_tenant_command (
      p_mapping_id => (
        current_setting('tenant.map2')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_command_type => 'provision',
      p_reason => '重复开通',
      p_idempotency_key => 'idem-provision-2',
      p_expected_sync_version => 0
    ) ->> 'status',
    'mapping_already_bound',
    'C8 provisioning an already bound mapping is refused'
  );


SELECT
  IS (
    ops.create_tenant_command (
      p_mapping_id => (
        current_setting('tenant.map')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_command_type => 'activate',
      p_reason => '激活',
      p_idempotency_key => 'idem-activate-1',
      p_expected_sync_version => 7
    ) ->> 'status',
    'sync_version_mismatch',
    'C9 a stale expectedSyncVersion is refused - that is the optimistic lock'
  );


SELECT
  IS (
    ops.create_tenant_command (
      p_mapping_id => (
        current_setting('tenant.map')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_command_type => 'activate',
      p_reason => '   ',
      p_idempotency_key => 'idem-activate-blank',
      p_expected_sync_version => 0
    ) ->> 'status',
    'reason_required',
    'C10 a blank reason is not a reason'
  );


SELECT
  IS (
    ops.create_tenant_command (
      p_mapping_id => (
        current_setting('tenant.map')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_command_type => 'activate',
      p_reason => '激活',
      p_idempotency_key => 'idem-activate-cr-missing',
      p_expected_sync_version => 0,
      p_change_request_id => '00000000-0000-4000-8000-0000000008ff'
    ) ->> 'status',
    'change_request_not_found',
    'C11 a change request that does not exist is refused'
  );


-- 契约 §3.6：关联变更申请必须已审批。未审批就下发等于把「批不批」交给远端。
SELECT
  IS (
    ops.create_tenant_command (
      p_mapping_id => (
        current_setting('tenant.map')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_command_type => 'activate',
      p_reason => '拿待审批的单子去激活',
      p_idempotency_key => 'idem-activate-cr-pending',
      p_expected_sync_version => 0,
      p_change_request_id => '00000000-0000-4000-8000-0000000008f1'
    ) ->> 'status',
    'change_request_not_approved',
    'C12 an unapproved change request cannot be dispatched'
  );


-- 换到只懂 suspend 的身份：建 suspend 命令必须放行（说明权限按类型判），
-- 建 sync_entitlement 必须 42501（它要的是 entitlement.execute）。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000008b2","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    ops.create_tenant_command (
      p_mapping_id => (
        current_setting('tenant.map')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_command_type => 'suspend',
      p_reason => '还没开通就停服',
      p_idempotency_key => 'idem-suspend-early',
      p_expected_sync_version => 0
    ) ->> 'status',
    'mapping_not_active',
    'C13 tenant.suspend passes the permission gate and then hits the state guard'
  );


SELECT
  throws_ok (
    'SELECT ops.create_tenant_command(p_mapping_id => ''00000000-0000-4000-8000-0000000008d9'', p_command_type => ''sync_entitlement'', p_reason => ''同步'', p_idempotency_key => ''idem-sync-denied'', p_expected_sync_version => 0)',
    '42501',
    NULL,
    'C14 sync_entitlement needs entitlement.execute, which tenant.suspend does not imply'
  );


-- ══ A：下发结果（系统侧，只有超级用户能调）═════════════════════════════════
RESET ROLE;


-- 设计要点 4：运营端拿不到这个函数，「202 只表示已受理」才成立。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000008b3","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    format(
      'SELECT ops.record_tenant_command_attempt(p_command_id => %L, p_outcome => ''succeeded'')',
      current_setting('tenant.cmd')::jsonb #>> '{command,id}'
    ),
    '42501',
    NULL,
    'A1 an operator cannot mark a command as succeeded'
  );


RESET ROLE;


-- provision 成功了却没回 org id：没有东西能证明租户真的被建了，
-- 记成成功会让映射永远停在「pending 但已绑定」的悬空状态。
SELECT
  IS (
    ops.record_tenant_command_attempt (
      p_command_id => (
        current_setting('tenant.cmd')::jsonb #>> '{command,id}'
      )::uuid,
      p_outcome => 'succeeded',
      p_response_summary => '{"state":"OK"}'::jsonb
    ) ->> 'status',
    'organization_missing_in_response',
    'A2 a provision that returns no organization id is not a success'
  );


SELECT
  IS (
    ops.record_tenant_command_attempt (
      p_command_id => (
        current_setting('tenant.cmd')::jsonb #>> '{command,id}'
      )::uuid,
      p_outcome => 'succeeded',
      p_response_summary => '{"udoneOrganizationId":"not-a-uuid"}'::jsonb
    ) ->> 'status',
    'invalid_organization_id',
    'A3 a malformed organization id is refused before anything is written'
  );


SELECT
  set_config(
    'tenant.done',
    ops.record_tenant_command_attempt (
      p_command_id => (
        current_setting('tenant.cmd')::jsonb #>> '{command,id}'
      )::uuid,
      p_outcome => 'succeeded',
      p_http_status => 201,
      p_response_summary => '{"udoneOrganizationId":"00000000-0000-4000-8000-0000000008d1","state":"PROVISIONED"}'::jsonb,
      p_request_id => 'req-1'
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('tenant.done')::jsonb #>> '{command,status}',
    'succeeded',
    'A4 only a confirmed response turns a command into succeeded'
  );


SELECT
  IS (
    (
      current_setting('tenant.done')::jsonb #>> '{mapping,sync_version}'
    )::integer,
    1,
    'A5 a confirmed dispatch advances sync_version by exactly one'
  );


SELECT
  IS (
    current_setting('tenant.done')::jsonb #>> '{mapping,mapping_status}',
    'pending',
    'A6 provisioning binds the organization but does not activate the mapping'
  );


SELECT
  IS (
    current_setting('tenant.done')::jsonb #>> '{mapping,last_known_state}',
    'PROVISIONED',
    'A7 last_known_state keeps what the remote actually reported'
  );


SELECT
  IS (
    ops.record_tenant_command_attempt (
      p_command_id => (
        current_setting('tenant.cmd')::jsonb #>> '{command,id}'
      )::uuid,
      p_outcome => 'succeeded'
    ) ->> 'status',
    'command_terminated',
    'A8 a succeeded command cannot be written twice'
  );


-- 激活：这是让映射真正变成 active 的那一步。
SELECT
  set_config(
    'tenant.activate',
    ops.create_tenant_command (
      p_mapping_id => (
        current_setting('tenant.map')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_command_type => 'activate',
      p_reason => '开通完成',
      p_idempotency_key => 'idem-activate-2',
      p_expected_sync_version => 1
    )::text,
    TRUE
  );


SELECT
  set_config(
    'tenant.activated',
    ops.record_tenant_command_attempt (
      p_command_id => (
        current_setting('tenant.activate')::jsonb #>> '{command,id}'
      )::uuid,
      p_outcome => 'succeeded',
      p_response_summary => '{"state":"ACTIVE"}'::jsonb
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('tenant.activated')::jsonb #>> '{mapping,mapping_status}',
    'active',
    'A9 activating a mapping makes it active'
  );


SELECT
  IS (
    (
      current_setting('tenant.activated')::jsonb #>> '{mapping,sync_version}'
    )::integer,
    2,
    'A10 sync_version keeps counting confirmations'
  );


-- 乐观锁真的在工作：拿旧版本号发命令必须被挡。
SELECT
  IS (
    ops.create_tenant_command (
      p_mapping_id => (
        current_setting('tenant.map')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_command_type => 'sync_entitlement',
      p_reason => '拿旧版本同步',
      p_idempotency_key => 'idem-sync-stale',
      p_expected_sync_version => 0
    ) ->> 'status',
    'sync_version_mismatch',
    'A11 after a confirmation the old sync_version can no longer dispatch'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000008b3","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  set_config(
    'tenant.sync',
    ops.create_tenant_command (
      p_mapping_id => (
        current_setting('tenant.map')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_command_type => 'sync_entitlement',
      p_reason => '同步权益',
      p_idempotency_key => 'idem-sync-1',
      p_expected_sync_version => 2
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('tenant.sync')::jsonb #>> '{command,status}',
    'pending',
    'A12 sync_entitlement is allowed on an active mapping'
  );


RESET ROLE;


SELECT
  set_config(
    'tenant.failed',
    ops.record_tenant_command_attempt (
      p_command_id => (
        current_setting('tenant.sync')::jsonb #>> '{command,id}'
      )::uuid,
      p_outcome => 'failed',
      p_http_status => 503,
      p_error_category => 'transient',
      p_error_code => 'UPSTREAM_UNAVAILABLE'
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('tenant.failed')::jsonb #>> '{command,status}',
    'failed',
    'A13 a failed attempt leaves the command failed'
  );


SELECT
  IS (
    current_setting('tenant.failed')::jsonb #>> '{command,last_error_category}',
    'transient',
    'A14 the error category is kept so retry can decide'
  );


SELECT
  isnt (
    current_setting('tenant.failed')::jsonb #>> '{command,next_retry_at}',
    NULL,
    'A15 a transient failure schedules the next retry'
  );


SELECT
  IS (
    (
      current_setting('tenant.failed')::jsonb #>> '{mapping,sync_version}'
    )::integer,
    2,
    'A16 a failure does not advance sync_version - the remote did not change'
  );


-- 一个 B 既有权限（tenant.suspend）、又已经失败的 suspend 命令。
-- A17 要证的只是「重试还要 tenant.retry」，所以必须让 B 先过原动作码那一关：
-- 换 sync_entitlement 来证是证不出来的——B 连 entitlement.execute 都没有，
-- 42501 会由那一个先触发，断言就变成在证另一件事。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000008b2","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'tenant.suspend',
    ops.create_tenant_command (
      p_mapping_id => (
        current_setting('tenant.map')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_command_type => 'suspend',
      p_reason => '演练停服',
      p_idempotency_key => 'idem-suspend-1',
      p_expected_sync_version => 2
    )::text,
    TRUE
  );


RESET ROLE;


SELECT
  set_config(
    'tenant.suspend.failed',
    ops.record_tenant_command_attempt (
      p_command_id => (
        current_setting('tenant.suspend')::jsonb #>> '{command,id}'
      )::uuid,
      p_outcome => 'failed',
      p_http_status => 503,
      p_error_category => 'transient',
      p_error_code => 'UPSTREAM_UNAVAILABLE'
    )::text,
    TRUE
  );


-- 重试要两个动作码：tenant.retry + 原命令的动作码。只有 tenant.suspend 的人不行。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000008b2","role":"authenticated"}',
    TRUE
  );


SELECT
  throws_ok (
    format(
      'SELECT ops.transition_tenant_command(p_command_id => %L, p_action => ''retry'', p_reason => ''重试'')',
      current_setting('tenant.suspend')::jsonb #>> '{command,id}'
    ),
    '42501',
    NULL,
    'A17 retry needs tenant.retry on top of the command own action code'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000008b3","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    ops.transition_tenant_command (
      p_command_id => (
        current_setting('tenant.sync')::jsonb #>> '{command,id}'
      )::uuid,
      p_action => 'retry',
      p_reason => '上游恢复了'
    ) ->> 'status',
    'ok',
    'A18 the delivery role can retry'
  );


SELECT
  IS (
    ops.get_tenant_command (
      (
        current_setting('tenant.sync')::jsonb #>> '{command,id}'
      )::uuid
    ) #>> '{command,status}',
    'retrying',
    'A19 retry moves the command to retrying, not back to pending'
  );


RESET ROLE;


SELECT
  set_config(
    'tenant.retried',
    ops.record_tenant_command_attempt (
      p_command_id => (
        current_setting('tenant.sync')::jsonb #>> '{command,id}'
      )::uuid,
      p_outcome => 'succeeded',
      p_response_summary => '{"state":"SYNCED"}'::jsonb
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('tenant.retried')::jsonb #>> '{command,status}',
    'succeeded',
    'A20 a retried command can still succeed'
  );


SELECT
  IS (
    (
      current_setting('tenant.retried')::jsonb #>> '{command,attempt_count}'
    )::integer,
    2,
    'A21 attempts accumulate across retries instead of resetting'
  );


SELECT
  IS (
    (
      current_setting('tenant.retried')::jsonb #>> '{mapping,sync_version}'
    )::integer,
    3,
    'A22 the successful retry is the one that advances the version'
  );


-- 永久错误：不排下一次重试，也不许重试。
SELECT
  set_config(
    'tenant.permanent',
    ops.create_tenant_command (
      p_mapping_id => (
        current_setting('tenant.map')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_command_type => 'sync_entitlement',
      p_reason => '永久错误演练',
      p_idempotency_key => 'idem-sync-permanent',
      p_expected_sync_version => 3
    )::text,
    TRUE
  );


SELECT
  set_config(
    'tenant.permanent.failed',
    ops.record_tenant_command_attempt (
      p_command_id => (
        current_setting('tenant.permanent')::jsonb #>> '{command,id}'
      )::uuid,
      p_outcome => 'failed',
      p_http_status => 400,
      p_error_category => 'permanent',
      p_error_code => 'SCHEMA_MISMATCH'
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('tenant.permanent.failed')::jsonb #>> '{command,next_retry_at}',
    NULL,
    'A23 a permanent failure schedules nothing'
  );


SELECT
  IS (
    ops.get_tenant_command (
      (
        current_setting('tenant.permanent')::jsonb #>> '{command,id}'
      )::uuid
    ) #>> '{retryable}',
    'false',
    'A24 a permanent failure is not retryable'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000008b3","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    ops.transition_tenant_command (
      p_command_id => (
        current_setting('tenant.permanent')::jsonb #>> '{command,id}'
      )::uuid,
      p_action => 'retry',
      p_reason => '还是要重试'
    ) ->> 'status',
    'permanent_error',
    'A25 retrying a permanent failure is a state conflict, not a permission problem'
  );


-- 超时：结果未知，命令必须留在 pending。
RESET ROLE;


SELECT
  set_config(
    'tenant.slow',
    ops.create_tenant_command (
      p_mapping_id => (
        current_setting('tenant.map')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_command_type => 'sync_entitlement',
      p_reason => '超时演练',
      p_idempotency_key => 'idem-sync-timeout',
      p_expected_sync_version => 3
    )::text,
    TRUE
  );


SELECT
  set_config(
    'tenant.timedout',
    ops.record_tenant_command_attempt (
      p_command_id => (
        current_setting('tenant.slow')::jsonb #>> '{command,id}'
      )::uuid,
      p_outcome => 'timeout',
      p_error_category => 'transient'
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('tenant.timedout')::jsonb #>> '{command,status}',
    'pending',
    'A26 a timeout leaves the command pending - the remote result is unknown'
  );


SELECT
  IS (
    current_setting('tenant.timedout')::jsonb #>> '{attempt,outcome}',
    'timeout',
    'A27 the attempt records timeout as an outcome of its own'
  );


SELECT
  isnt (
    current_setting('tenant.timedout')::jsonb #>> '{command,next_retry_at}',
    NULL,
    'A28 a timeout schedules a re-check'
  );


-- 取消：只有一次都没发出去过才行。
SELECT
  IS (
    ops.transition_tenant_command (
      p_command_id => (
        current_setting('tenant.timedout')::jsonb #>> '{command,id}'
      )::uuid,
      p_action => 'cancel',
      p_reason => '想取消已经发过的'
    ) ->> 'status',
    'command_attempted',
    'A29 a command that was dispatched cannot be cancelled'
  );


SELECT
  set_config(
    'tenant.fresh',
    ops.create_tenant_command (
      p_mapping_id => (
        current_setting('tenant.map')::jsonb #>> '{mapping,id}'
      )::uuid,
      p_command_type => 'sync_entitlement',
      p_reason => '建了就撤',
      p_idempotency_key => 'idem-sync-cancel',
      p_expected_sync_version => 3
    )::text,
    TRUE
  );


SELECT
  IS (
    ops.transition_tenant_command (
      p_command_id => (
        current_setting('tenant.fresh')::jsonb #>> '{command,id}'
      )::uuid,
      p_action => 'cancel',
      p_reason => '建错了'
    ) ->> 'status',
    'ok',
    'A30 a command that was never dispatched can be cancelled'
  );


SELECT
  IS (
    ops.record_tenant_command_attempt (
      p_command_id => (
        current_setting('tenant.fresh')::jsonb #>> '{command,id}'
      )::uuid,
      p_outcome => 'succeeded'
    ) ->> 'status',
    'command_terminated',
    'A31 a cancelled command cannot later be marked done'
  );


SELECT
  throws_ok (
    format(
      'UPDATE ops.tenant_command_attempts SET outcome = ''succeeded'' WHERE command_id = %L',
      current_setting('tenant.sync')::jsonb #>> '{command,id}'
    ),
    '23001',
    NULL,
    'A32 attempts are append-only even for the table owner'
  );


-- 状态机：succeeded 没有可做的动作。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000008b3","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  set_config(
    'tenant.noop',
    ops.transition_tenant_command (
      p_command_id => (
        current_setting('tenant.sync')::jsonb #>> '{command,id}'
      )::uuid,
      p_action => 'cancel',
      p_reason => '想撤销成功的'
    )::text,
    TRUE
  );


SELECT
  IS (
    current_setting('tenant.noop')::jsonb #>> '{status}',
    'invalid_transition',
    'A33 a succeeded command has no further transitions'
  );


SELECT
  IS (
    jsonb_array_length(
      current_setting('tenant.noop')::jsonb -> 'allowed_actions'
    ),
    0,
    'A34 the refusal lists the allowed actions - none, in this case'
  );


-- ══ V：读 ═══════════════════════════════════════════════════════════════════
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000008b4","role":"authenticated"}',
    TRUE
  );


SELECT
  ok (
    (
      ops.list_tenant_mappings (
        p_customer_id => '00000000-0000-4000-8000-0000000008c1'
      ) ->> 'total'
    )::integer >= 1,
    'V1 a read-only account can list mappings by customer'
  );


SELECT
  IS (
    (
      ops.list_tenant_commands (
        p_mapping_id => (
          current_setting('tenant.map')::jsonb #>> '{mapping,id}'
        )::uuid
      ) ->> 'total'
    )::integer >= 5,
    TRUE,
    'V2 every command created above is attributed to the mapping'
  );


SELECT
  ok (
    jsonb_array_length(
      ops.get_tenant_command (
        (
          current_setting('tenant.sync')::jsonb #>> '{command,id}'
        )::uuid
      ) -> 'attempts'
    ) = 2,
    'V3 the command detail carries both attempts, in order'
  );


SELECT
  ok (
    jsonb_array_length(
      ops.get_tenant_mapping (
        (
          current_setting('tenant.map')::jsonb #>> '{mapping,id}'
        )::uuid
      ) -> 'commands'
    ) >= 1,
    'V4 the mapping detail carries its recent commands'
  );


SELECT
  IS (
    ops.get_tenant_command ('00000000-0000-4000-8000-0000000008d9') ->> 'status',
    'command_not_found',
    'V5 an unknown command is a not-found, not an empty object'
  );


SELECT
  IS (
    ops.list_tenant_command_attempts ('00000000-0000-4000-8000-0000000008d9') ->> 'status',
    'command_not_found',
    'V6 asking for the attempts of an unknown command is a not-found too'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000008b5","role":"authenticated"}',
    TRUE
  );


SELECT
  throws_ok (
    'SELECT ops.list_tenant_mappings()',
    '42501',
    NULL,
    'V7 an operator without a role cannot read mappings'
  );


-- 业务身份连表都读不到：读侧只能走 RPC。
SELECT
  throws_ok (
    'SELECT count(*) FROM ops.tenant_commands',
    '42501',
    NULL,
    'V8 authenticated cannot select the command table directly'
  );


-- ══ U：审计 ═════════════════════════════════════════════════════════════════
RESET ROLE;


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'tenant_mapping.created'
        AND event.entity_id = (
          current_setting('tenant.map')::jsonb #>> '{mapping,id}'
        )::uuid
    ),
    'U1 creating a mapping is audited'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'tenant_command.created'
        AND event.entity_id = (
          current_setting('tenant.cmd')::jsonb #>> '{command,id}'
        )::uuid
    ),
    'U2 creating a command is audited'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'tenant_command.succeeded'
        AND event.entity_id = (
          current_setting('tenant.cmd')::jsonb #>> '{command,id}'
        )::uuid
    ),
    'U3 a confirmed dispatch is audited under its own action'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'tenant_command.failed'
        AND event.entity_id = (
          current_setting('tenant.sync')::jsonb #>> '{command,id}'
        )::uuid
    ),
    'U4 a failed dispatch is audited separately from a confirmed one'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'tenant_command.timed_out'
        AND event.entity_id = (
          current_setting('tenant.slow')::jsonb #>> '{command,id}'
        )::uuid
    ),
    'U5 a timeout is audited as a timeout, not as a failure'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;