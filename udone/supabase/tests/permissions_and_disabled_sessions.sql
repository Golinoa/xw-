BEGIN;


SELECT
  plan (26);


INSERT INTO
  auth.users (
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
  )
VALUES
  (
    '60000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'scope-admin@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    '60000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'scope-operator@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    '60000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'scope-finance@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    '60000000-0000-4000-8000-000000000004',
    'authenticated',
    'authenticated',
    'scope-disabled@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    '60000000-0000-4000-8000-000000000005',
    'authenticated',
    'authenticated',
    'invitee@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  );


INSERT INTO
  public.organizations (id, name, created_by)
VALUES
  (
    '70000000-0000-4000-8000-000000000001',
    'Scope Org One',
    '60000000-0000-4000-8000-000000000001'
  ),
  (
    '70000000-0000-4000-8000-000000000002',
    'Scope Org Two',
    '60000000-0000-4000-8000-000000000001'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role, status)
VALUES
  (
    '70000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000001',
    'admin',
    'active'
  ),
  (
    '70000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000002',
    'operator',
    'active'
  ),
  (
    '70000000-0000-4000-8000-000000000002',
    '60000000-0000-4000-8000-000000000003',
    'finance',
    'active'
  ),
  (
    '70000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000004',
    'operator',
    'disabled'
  );


SET
  LOCAL ROLE authenticated;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"60000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"70000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  IS (
    public.current_data_scope (),
    'own',
    'operator data scope is own'
  );


SELECT
  ok (
    public.has_permission ('organization.read'),
    'operator receives organization read'
  );


SELECT
  ok (
    NOT public.has_permission ('member.manage'),
    'operator cannot manage members'
  );


-- 这是权限集的快照断言：新增权限时它必然失败，这正是它的用途——
-- 逼人显式确认「这条新权限真的该给这个角色」。
-- 客户/订单/供应商域上线后 operator 获得对应读写权限，此处随之更新。
SELECT
  IS (
    (
      SELECT
        permissions
      FROM
        public.get_current_auth_context ('70000000-0000-4000-8000-000000000001')
    ),
    ARRAY[
      'customer.read',
      'customer.sensitive.read',
      'customer.write',
      'order.read',
      'order.write',
      'organization.read',
      'supplier.read',
      'supplier.write'
    ]::TEXT[],
    'operator auth context comes from database role grants'
  );


SELECT
  throws_ok (
    $$ SELECT * FROM public.create_organization_invitation('70000000-0000-4000-8000-000000000001', 'forbidden@example.test', 'finance') $$,
    '42501',
    NULL,
    'operator cannot create organization invitations'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"60000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"70000000-0000-4000-8000-000000000002"}',
    TRUE
  );


SELECT
  IS (
    public.current_data_scope (),
    'all',
    'finance data scope is all within its granted modules'
  );


SELECT
  ok (
    public.has_permission ('audit.read'),
    'finance receives audit read'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"60000000-0000-4000-8000-000000000004","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"70000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  IS (
    public.current_organization_id (),
    NULL::uuid,
    'disabled membership has no selected organization'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.get_current_auth_context ('70000000-0000-4000-8000-000000000001')
    ),
    0,
    'disabled membership is rejected by per-request auth context'
  );


SELECT
  ok (
    NOT public.has_permission ('organization.read'),
    'disabled membership has no permissions'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"60000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"70000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  IS (
    public.current_data_scope (),
    'all',
    'admin data scope is all'
  );


SELECT
  ok (
    public.has_permission ('member.manage'),
    'admin receives member management'
  );


SELECT
  IS (
    (
      SELECT
        invitation_created
      FROM
        public.create_organization_invitation (
          '70000000-0000-4000-8000-000000000001',
          'INVITEE@EXAMPLE.TEST',
          'operator'
        )
    ),
    TRUE,
    'admin can create an organization invitation'
  );


RESET ROLE;


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.organization_invitations
      WHERE
        organization_id = '70000000-0000-4000-8000-000000000001'
        AND normalized_email = 'invitee@example.test'
        AND role = 'operator'
        AND status = 'pending'
    ),
    1,
    'invitation email is normalized and remains pending'
  );


SELECT
  ok (
    (
      SELECT
        expires_at > now()
      FROM
        public.organization_invitations
      WHERE
        normalized_email = 'invitee@example.test'
    ),
    'pending invitation has a bounded future expiry'
  );


SELECT
  IS (
    (
      SELECT
        invitation_created
      FROM
        public.create_organization_invitation (
          '70000000-0000-4000-8000-000000000001',
          'invitee@example.test',
          'operator'
        )
    ),
    FALSE,
    'replaying an invitation does not create a duplicate'
  );


SELECT
  throws_ok (
    $$ SELECT * FROM public.create_organization_invitation('70000000-0000-4000-8000-000000000001', 'invitee@example.test', 'finance') $$,
    '23505',
    NULL,
    'replay cannot silently change the invited role'
  );


SELECT
  throws_ok (
    $$ SELECT * FROM public.update_organization_member('70000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'operator', 'disabled') $$,
    '23514',
    NULL,
    'organization cannot lose its last active admin'
  );


SELECT
  throws_ok (
    $$ SELECT * FROM public.update_organization_member('70000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000003', 'admin', 'active') $$,
    '42501',
    NULL,
    'admin cannot update a member in another organization'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"60000000-0000-4000-8000-000000000004","role":"authenticated"}',
    TRUE
  );


SELECT
  throws_ok (
    $$ SELECT * FROM public.accept_organization_invitation((SELECT id FROM public.organization_invitations WHERE normalized_email = 'invitee@example.test')) $$,
    '42501',
    NULL,
    'a different verified email cannot accept the invitation'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"60000000-0000-4000-8000-000000000005","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        membership_role
      FROM
        public.accept_organization_invitation (
          (
            SELECT
              id
            FROM
              public.organization_invitations
            WHERE
              normalized_email = 'invitee@example.test'
          )
        )
    ),
    'operator',
    'the invited user can accept using the matching verified email'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.organization_members
      WHERE
        organization_id = '70000000-0000-4000-8000-000000000001'
        AND user_id = '60000000-0000-4000-8000-000000000005'
        AND status = 'active'
    ),
    1,
    'accepted invitation creates an active organization membership'
  );


SELECT
  throws_ok (
    $$ SELECT * FROM public.accept_organization_invitation((SELECT id FROM public.organization_invitations WHERE normalized_email = 'invitee@example.test')) $$,
    '42501',
    NULL,
    'accepted invitations cannot be replayed'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"60000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        member_status
      FROM
        public.update_organization_member (
          '70000000-0000-4000-8000-000000000001',
          '60000000-0000-4000-8000-000000000002',
          'finance',
          'disabled'
        )
    ),
    'disabled',
    'admin can change a member role and disable access'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.get_current_auth_context ('70000000-0000-4000-8000-000000000001')
      WHERE
        organization_id = '70000000-0000-4000-8000-000000000001'
        AND role = 'operator'
    ),
    0,
    'disabled member immediately loses the request context'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        public.audit_events
      WHERE
        organization_id = '70000000-0000-4000-8000-000000000001'
        AND action = 'member.role_changed'
    ),
    'role and status updates append an organization audit event'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;