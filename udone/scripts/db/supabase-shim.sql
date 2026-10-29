-- 本地 PostgreSQL 的 Supabase 兼容层。
--
-- 生产环境用 Supabase，`auth` schema、`anon/authenticated/service_role` 角色、
-- public schema 的默认授权都由平台预置。本项目迁移依赖的最小面只有：
--   * 三个角色（迁移里有 REVOKE/GRANT 直接点名）
--   * auth.users 表（外键指向它）
--   * auth.uid() / auth.jwt() / auth.role()（RLS 里读请求身份）
--   * public 上的默认授权（迁移只对敏感表显式 REVOKE，其余靠默认授权）
--
-- 这里逐条对齐 Supabase 的 init 脚本，只补这些，**不**模拟 PostgREST / GoTrue
-- 的其它行为。目标是让迁移与 RLS 策略在真实 PostgreSQL 上被真正执行，
-- 而不是让本地环境尽量像 Supabase。
--
-- 破坏性：会 DROP SCHEMA auth CASCADE，只在一次性本地库上跑。

DROP SCHEMA IF EXISTS auth CASCADE;

-- service_role 在 Supabase 是 BYPASSRLS，anon/authenticated 不是。
-- 如果这里少给 BYPASSRLS，依赖「服务端角色能跨租户读」的测试会假失败；
-- 如果多给，本地的越权测试会假通过。两种都不能接受，所以严格照抄。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;

CREATE SCHEMA auth;

-- 只建测试与迁移真正用到的列。真实表还有几十列，但多建反而会让本地测试
-- 依赖上生产没有的行为差异，所以保持最小且精确。
CREATE TABLE auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aud text,
  role text,
  email text UNIQUE,
  encrypted_password text,
  email_confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- 与 Supabase 实现一致：优先读逐项 claim，再回落到整个 claims 负载。
CREATE OR REPLACE FUNCTION auth.uid () returns uuid language sql stable AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

CREATE OR REPLACE FUNCTION auth.jwt () returns jsonb language sql stable AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

CREATE OR REPLACE FUNCTION auth.role () returns text language sql stable AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

GRANT usage ON schema auth TO anon, authenticated, service_role;

GRANT
EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon,
authenticated,
service_role;

-- 平台默认授权：迁移里没显式 GRANT 的表，生产上是靠这条能读写的。
-- 少了它，本地会误报「表不可读」；多了它，又会掩盖迁移漏写 GRANT 的问题。
-- Supabase init 脚本正是这么设的，所以照抄。
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
