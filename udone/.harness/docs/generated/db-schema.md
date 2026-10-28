<!-- AUTO-GENERATED FILE: generated from supabase/migrations by scripts/generate-db-schema.mjs. Do not hand edit. -->
# Database schema inventory

> Migration-derived object inventory. Names are extracted from SQL declarations; this report does not infer product fields or runtime behavior.

- Migration sources scanned: 5
- Tables discovered: 7
- Functions discovered: 12
- Indexes discovered: 4
- RLS policies discovered: 16
- Triggers discovered: 0

| Migration | Tables | Functions | Indexes | Policies | Triggers |
|---|---|---|---|---|---|
| `20261003000000_identity.sql` | `public.organizations`, `public.organization_members`, `public.profiles`, `public.audit_events` | — | `organization_members_user_id_idx`, `audit_events_organization_created_at_idx` | — | — |
| `20261003000001_rls_helpers.sql` | — | `public.current_organization_id`, `public.is_organization_creator`, `public.has_permission` | — | `organization_members_insert_initial_admin`, `organizations_select_member`, `organizations_insert_creator`, `organizations_update_admin`, `organization_members_select_current_org`, `organization_members_update_current_admin`, `profiles_select_self`, `profiles_insert_self`, `profiles_update_self`, `audit_events_select_audit_permission` | — |
| `20261003000002_organization_context_api.sql` | — | `public.create_organization_with_owner` | — | `organization_members_select_self`, `organizations_select_member_self` | — |
| `20261003000003_request_organization_context.sql` | — | `public.current_organization_id` | — | `organization_members_select_self`, `organizations_select_member_self` | — |
| `20261003000004_permissions_and_member_lifecycle.sql` | `public.organization_role_permissions`, `public.organization_role_data_scopes`, `public.organization_invitations` | `public.current_organization_id`, `public.has_permission`, `public.current_data_scope`, `public.get_current_auth_context`, `public.create_organization_invitation`, `public.accept_organization_invitation`, `public.update_organization_member` | `organization_invitations_pending_email_idx`, `organization_invitations_pending_expiry_idx` | `organization_members_select_self`, `organizations_select_member_self` | — |
