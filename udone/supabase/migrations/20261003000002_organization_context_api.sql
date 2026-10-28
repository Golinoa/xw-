-- A user must be able to discover and validate their own memberships across
-- organizations before selecting one. Other users' memberships remain hidden.
CREATE POLICY organization_members_select_self ON public.organization_members FOR
SELECT
  TO authenticated USING (
    user_id = (
      SELECT
        auth.uid ()
    )
  );


CREATE POLICY organizations_select_member_self ON public.organizations FOR
SELECT
  TO authenticated USING (
    EXISTS (
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
  );


-- PostgREST executes a single function call in one database transaction. This
-- function creates the organization and its initial owner membership atomically.
CREATE OR REPLACE FUNCTION public.create_organization_with_owner (requested_name text) returns TABLE (
  organization_id uuid,
  organization_name text,
  membership_role text
) language plpgsql security definer
SET
  search_path = '' AS $$
declare
  caller_id uuid := (select auth.uid());
  created_id uuid;
begin
  if caller_id is null then
    raise exception 'Authentication is required' using errcode = '28000';
  end if;

  if requested_name is null or length(btrim(requested_name)) = 0 then
    raise exception 'Organization name is required' using errcode = '22023';
  end if;

  insert into public.organizations (name, created_by)
  values (btrim(requested_name), caller_id)
  returning id into created_id;

  insert into public.organization_members (organization_id, user_id, role)
  values (created_id, caller_id, 'admin');

  return query select created_id, btrim(requested_name), 'admin'::text;
end;
$$;


REVOKE ALL ON function public.create_organization_with_owner (text)
FROM
  public,
  anon;


GRANT
EXECUTE ON function public.create_organization_with_owner (text) TO authenticated,
service_role;