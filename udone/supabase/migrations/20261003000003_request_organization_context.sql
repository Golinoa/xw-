CREATE OR REPLACE FUNCTION public.current_organization_id () returns uuid language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  request_headers pg_catalog.jsonb;
  selected_organization_text text;
  selected_organization_id uuid;
begin
  request_headers := nullif(current_setting('request.headers', true), '')::pg_catalog.jsonb;
  selected_organization_text := request_headers ->> 'x-organization-id';
  if selected_organization_text is null then
    return null;
  end if;

  begin
    selected_organization_id := selected_organization_text::uuid;
  exception when invalid_text_representation then
    return null;
  end;

  if not exists (
    select 1
    from public.organization_members as member
    where member.user_id = (select auth.uid())
      and member.organization_id = selected_organization_id
  ) then
    return null;
  end if;

  return selected_organization_id;
exception when invalid_text_representation then
  return null;
end;
$$;


-- Membership/organization discovery is available without a selected context.
-- Once a context is supplied, reads are restricted to that organization.
DROP POLICY organization_members_select_self ON public.organization_members;


CREATE POLICY organization_members_select_self ON public.organization_members FOR
SELECT
  TO authenticated USING (
    NOT coalesce(
      (
        nullif(current_setting('request.headers', TRUE), '')::pg_catalog.jsonb
      ) ? 'x-organization-id',
      FALSE
    )
    AND user_id = (
      SELECT
        auth.uid ()
    )
    OR organization_id = (
      SELECT
        public.current_organization_id ()
    )
  );


DROP POLICY organizations_select_member_self ON public.organizations;


CREATE POLICY organizations_select_member_self ON public.organizations FOR
SELECT
  TO authenticated USING (
    NOT coalesce(
      (
        nullif(current_setting('request.headers', TRUE), '')::pg_catalog.jsonb
      ) ? 'x-organization-id',
      FALSE
    )
    AND EXISTS (
      SELECT
        1
      FROM
        public.organization_members AS member
      WHERE
        member.organization_id = organizations.id
        AND member.user_id = (
          SELECT
            auth.uid ()
        )
    )
    OR id = (
      SELECT
        public.current_organization_id ()
    )
  );


REVOKE ALL ON function public.current_organization_id ()
FROM
  public,
  anon;


GRANT
EXECUTE ON function public.current_organization_id () TO authenticated,
service_role;