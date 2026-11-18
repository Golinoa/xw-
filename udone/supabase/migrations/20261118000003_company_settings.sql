-- C12 公司配置（数据库层）：租户侧设置表 + 版本化写入 + 强制审计。
--
-- 口径来自 Docs/REQUIREMENTS.md R-SETTING-01：公司资料、主题、字号、业务字典、
-- 审批与订单规则；保存必须版本化并留审计；影响财务/权限的配置需要二次确认。
-- Logo 上传明确不在首期范围，因此这里没有附件字段。
--
-- 版本冲突必须在库里判，不能只靠前端带回来的数字——两个管理员同时打开页面时，
-- 只靠前端会静默覆盖其中一个人的改动。
CREATE TABLE public.company_settings (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations (id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);


COMMENT ON TABLE public.company_settings IS '租户侧公司配置；单一行按版本覆盖，写入只走 RPC。';


ALTER TABLE public.company_settings enable ROW level security;


CREATE POLICY company_settings_select_member ON public.company_settings FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
  );


-- 没有写策略是刻意的：直接 UPDATE 会绕过版本校验与审计，只有 RPC 能改。
CREATE OR REPLACE FUNCTION public.get_company_settings () RETURNS jsonb LANGUAGE sql STABLE
SET
  search_path = '' AS $$
  SELECT pg_catalog.jsonb_build_object(
    'organizationId', settings.organization_id,
    'data', settings.data,
    'version', settings.version,
    'updatedAt', settings.updated_at,
    'updatedBy', settings.updated_by
  )
  FROM public.company_settings AS settings
  WHERE settings.organization_id = public.current_organization_id ()
  UNION ALL
  SELECT pg_catalog.jsonb_build_object(
    'organizationId', public.current_organization_id (),
    'data', '{}'::jsonb,
    'version', 0,
    'updatedAt', NULL,
    'updatedBy', NULL
  )
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.company_settings AS settings
    WHERE settings.organization_id = public.current_organization_id ()
  );
$$;


CREATE OR REPLACE FUNCTION public.update_company_settings (
  requested_data jsonb,
  requested_expected_version integer
) RETURNS TABLE (result jsonb, error_code text) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  current_user_id uuid := (SELECT auth.uid ());
  old_data jsonb := '{}'::jsonb;
  current_version integer := 0;
  changed_keys text[];
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;
  IF NOT (SELECT public.has_permission ('settings.manage')) THEN
    RAISE EXCEPTION 'settings.manage is required' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.jsonb_typeof(requested_data) <> 'object'
    OR requested_expected_version IS NULL
    OR requested_expected_version < 0 THEN
    RETURN QUERY SELECT NULL::jsonb, 'INVALID_DATA'::text;
    RETURN;
  END IF;

  SELECT settings.data, settings.version INTO old_data, current_version
  FROM public.company_settings AS settings
  WHERE settings.organization_id = current_org_id
  FOR UPDATE;

  -- 第一次保存没有行，SELECT INTO 会把两个变量都置 NULL，不能拿它当版本号。
  IF current_version IS NULL THEN
    current_version := 0;
    old_data := '{}'::jsonb;
  END IF;

  IF current_version <> requested_expected_version THEN
    RETURN QUERY SELECT NULL::jsonb, 'VERSION_CONFLICT'::text;
    RETURN;
  END IF;

  SELECT pg_catalog.array_agg(entry.key ORDER BY entry.key) INTO changed_keys
  FROM pg_catalog.jsonb_each(requested_data) AS entry
  WHERE entry.value IS DISTINCT FROM (old_data -> entry.key);

  IF pg_catalog.array_length(changed_keys, 1) IS NULL THEN
    changed_keys := ARRAY[]::text[];
  END IF;

  INSERT INTO public.company_settings (organization_id, data, version, updated_by, updated_at)
  VALUES (
    current_org_id, requested_data, current_version + 1, current_user_id, pg_catalog.now()
  )
  ON CONFLICT (organization_id) DO UPDATE
  SET
    data = excluded.data,
    version = excluded.version,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  INSERT INTO public.audit_events (
    organization_id, actor_id, action, entity_type, entity_id, metadata
  ) VALUES (
    current_org_id, current_user_id, 'company_settings.update', 'company_settings',
    current_org_id,
    pg_catalog.jsonb_build_object(
      'version', current_version + 1,
      'changedKeys', pg_catalog.to_jsonb(changed_keys)
    )
  );

  RETURN QUERY SELECT pg_catalog.jsonb_build_object(
    'organizationId', current_org_id,
    'data', requested_data,
    'version', current_version + 1,
    'updatedAt', pg_catalog.now(),
    'updatedBy', current_user_id
  ), NULL::text;
END;
$$;


REVOKE ALL ON FUNCTION public.get_company_settings ()
FROM
  PUBLIC;


REVOKE ALL ON FUNCTION public.update_company_settings (jsonb, integer)
FROM
  PUBLIC;


GRANT
EXECUTE ON FUNCTION public.get_company_settings () TO authenticated;


GRANT
EXECUTE ON FUNCTION public.update_company_settings (jsonb, integer) TO authenticated;