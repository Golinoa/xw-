-- 运营端 schema 引导 + 幂等记录落库（运营契约 §2.5）。
--
-- 这份迁移只做两件事：建 `ops` schema、建 `ops.idempotency_records`。
-- `ops` 下的业务表按 T-02 之后的域逐个落，所以这里用 `if not exists`，
-- 让 T-02 可以安全地重复声明同一个 schema 而不必关心先后。
--
-- 为什么幂等记录不放在 public：
-- 它的每一行都是「某个用户的某个请求换回来了什么响应体」。这是跨租户可见的
-- 数据面——如果 authenticated 能读，一个租户就能读到别人的收付款响应。
-- 放在独立 schema 里只授权给 service_role，客户端令牌连 schema 的 USAGE 都没有。
--
-- 为什么同时上 GRANT 和 RLS（而不是只上一个）：
-- GRANT 管「这个角色能不能碰这张表」，RLS 管「能碰之后能看到哪些行」。
-- 这里两者都要「全拒」，因为没有任何一行是该给客户端看的。RLS 开启且不建
-- 任何 policy 时，非 BYPASSRLS 角色读到的行数恒为 0、写入恒被拒绝；service_role
-- 带 BYPASSRLS，照常读写。将来若有人误加一条 GRANT，RLS 仍然兜着。
CREATE SCHEMA if NOT EXISTS ops;


CREATE TABLE ops.idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 完整存储 key：sha256(Authorization) : 组织 : 方法 : 路径 : 客户端 key。
  -- 唯一约束是幂等的最后一道保险：两个并发同 key 请求中，只有一个能插入成功。
  scope_key text NOT NULL UNIQUE,
  -- 原始请求体的指纹（sha256 十六进制）。同 key 不同指纹说明客户端复用了 key，
  -- 必须回 409，而不是回放旧响应。
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  -- 只记 2xx：失败的请求必须保持可重试。
  status integer NOT NULL CHECK (status BETWEEN 200 AND 299),
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);


-- 清理任务按过期时间扫，没有这个索引就是全表扫。
CREATE INDEX idempotency_records_expires_at_idx ON ops.idempotency_records (expires_at);


ALTER TABLE ops.idempotency_records enable ROW level security;


REVOKE ALL ON schema ops
FROM
  public;


GRANT usage ON schema ops TO service_role;


GRANT
SELECT
,
  insert,
UPDATE,
delete ON ops.idempotency_records TO service_role;


COMMENT ON schema ops IS '运营后台（/api/v1/ops）专用 schema。暴露给 PostgREST 时只允许 service_role 与运营端函数访问。';


COMMENT ON TABLE ops.idempotency_records IS '幂等重放记录。只由 API Worker 以 service_role 读写，客户端令牌无任何权限。';


COMMENT ON COLUMN ops.idempotency_records.scope_key IS 'sha256(Authorization):组织:方法:路径:Idempotency-Key，不含原始令牌。';