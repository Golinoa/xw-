<!-- AUTO-GENERATED FILE: generated from supabase/migrations by scripts/generate-db-schema.mjs. Do not hand edit. -->
# Database schema inventory

> Migration-derived object inventory. Names are extracted from SQL declarations; this report does not infer product fields or runtime behavior.

- Migration sources scanned: 15
- Tables discovered: 18
- Functions discovered: 26
- Indexes discovered: 24
- RLS policies discovered: 55
- Triggers discovered: 2

| Migration | Tables | Functions | Indexes | Policies | Triggers |
|---|---|---|---|---|---|
| `20261003000000_identity.sql` | `public.organizations`, `public.organization_members`, `public.profiles`, `public.audit_events` | — | `organization_members_user_id_idx`, `audit_events_organization_created_at_idx` | — | — |
| `20261003000001_rls_helpers.sql` | — | `public.current_organization_id`, `public.is_organization_creator`, `public.has_permission` | — | `organization_members_insert_initial_admin`, `organizations_select_member`, `organizations_insert_creator`, `organizations_update_admin`, `organization_members_select_current_org`, `organization_members_update_current_admin`, `profiles_select_self`, `profiles_insert_self`, `profiles_update_self`, `audit_events_select_audit_permission` | — |
| `20261003000002_organization_context_api.sql` | — | `public.create_organization_with_owner` | — | `organization_members_select_self`, `organizations_select_member_self` | — |
| `20261003000003_request_organization_context.sql` | — | `public.current_organization_id` | — | `organization_members_select_self`, `organizations_select_member_self` | — |
| `20261003000004_permissions_and_member_lifecycle.sql` | `public.organization_role_permissions`, `public.organization_role_data_scopes`, `public.organization_invitations` | `public.current_organization_id`, `public.has_permission`, `public.current_data_scope`, `public.get_current_auth_context`, `public.create_organization_invitation`, `public.accept_organization_invitation`, `public.update_organization_member` | `organization_invitations_pending_email_idx`, `organization_invitations_pending_expiry_idx` | `organization_members_select_self`, `organizations_select_member_self` | — |
| `20261029000001_customer_domain.sql` | `public.customer_sources`, `public.customer_tags`, `public.customers`, `public.customer_tag_links` | `public.create_customer_with_tags` | `customer_sources_root_name_idx`, `customer_sources_child_name_idx`, `customer_sources_organization_idx`, `customers_organization_created_idx`, `customers_organization_phone_idx`, `customers_organization_source_idx`, `customers_organization_creator_idx`, `customer_tag_links_tag_idx` | `customers_select_scoped`, `customers_insert_writer`, `customers_update_writer`, `customer_sources_select_reader`, `customer_sources_insert_writer`, `customer_sources_update_writer`, `customer_tags_select_reader`, `customer_tags_insert_writer`, `customer_tag_links_select_reader`, `customer_tag_links_insert_writer`, `customer_tag_links_delete_writer` | — |
| `20261029000002_order_domain.sql` | `public.suppliers`, `public.orders`, `public.order_receivables`, `public.order_payables` | `public.recalculate_order_totals`, `public.create_order_with_items`, `public.update_order_with_items`, `public.transition_order_status` | `suppliers_organization_idx`, `orders_organization_created_idx`, `orders_organization_status_idx`, `orders_organization_customer_idx`, `orders_organization_departure_idx`, `order_receivables_order_idx`, `order_payables_order_idx`, `order_payables_supplier_idx` | `suppliers_select_reader`, `suppliers_insert_writer`, `suppliers_update_writer`, `orders_select_scoped`, `orders_insert_writer`, `orders_update_writer`, `order_receivables_select_reader`, `order_receivables_write_writer`, `order_payables_select_reader`, `order_payables_write_writer` | — |
| `20261029000003_finance_scope.sql` | — | — | — | `order_receivables_select_scoped`, `order_receivables_insert_writer`, `order_receivables_update_writer`, `order_receivables_delete_writer`, `order_payables_select_scoped`, `order_payables_insert_writer`, `order_payables_update_writer`, `order_payables_delete_writer` | — |
| `20261029000004_soft_delete_visibility.sql` | — | — | — | `customers_select_scoped`, `orders_select_scoped` | — |
| `20261029000005_order_write_grants.sql` | — | `public.sync_order_totals` | — | — | `order_receivables_sync_totals`, `order_payables_sync_totals` |
| `20261029000006_order_line_upsert.sql` | — | `public.update_order_with_items` | — | — | — |
| `20261029000007_line_write_state_guard.sql` | — | — | — | `order_receivables_insert_writer`, `order_receivables_update_writer`, `order_receivables_delete_writer`, `order_payables_insert_writer`, `order_payables_update_writer`, `order_payables_delete_writer` | — |
| `20261029000008_finance_applications.sql` | `public.finance_applications`, `public.finance_application_actions` | `public.release_finance_application_hold`, `public.confirm_finance_application_hold`, `public.release_finance_application_confirm`, `public.create_finance_application`, `public.decide_finance_application`, `public.undo_finance_application`, `public.withdraw_finance_application` | `finance_applications_order_index`, `finance_applications_pending_index`, `finance_application_actions_application_index` | `finance_applications_select_reader`, `finance_application_actions_select_reader` | — |
| `20261030000001_ops_schema_idempotency.sql` | `ops.idempotency_records` | — | `idempotency_records_expires_at_idx` | — | — |
| `20261030000002_ops_idempotency_align_contract.sql` | — | — | — | — | — |
