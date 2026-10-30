-- 幂等记录收敛为契约 §3 的两列主键形状（U-24 定稿，`o-t02b`）。
--
-- 原形状是一列 `scope_key = 调用者 : 组织 : 方法 : 路径 : 客户端 key` + UNIQUE。
-- 语义上没错，但它把两件不同的事塞进同一列：
--
--   1. **命名空间**——由（调用者、组织、方法、路径）决定，服务端算出来的；
--   2. **客户端 key**——调用方给的，格式受 `Idempotency-Key` 约束。
--
-- 分开之后有三件事变简单：按「这个人在这个端点上用过哪些键」查是 PK 前缀扫描，
-- 不必 `like '%…'`；排障时直接看到 key 原值，不用反解字符串；物理形状与契约 §3
-- 的清单一致，后来的人照着文档写查询不会落空。
--
-- 切点取**最后一个冒号**：调用者分量本身含冒号（`user:<sub>` / `token:<sha256>`），
-- 而客户端 key 只允许 `[A-Za-z0-9_-]`（中间件已校验，不含冒号）。所以最后一个
-- 冒号是唯一正确的分割位置——按第一个冒号切会把调用者切碎。
--
-- 存量行会被重写：这是本地与联调环境的数据，幂等记录本来就有 24h TTL，
-- 重写不改变任何语义（同一行仍落在同一个 scope+key 组合上）。
ALTER TABLE ops.idempotency_records
ADD COLUMN scope text;


ALTER TABLE ops.idempotency_records
ADD COLUMN key text;


UPDATE ops.idempotency_records
SET
  scope = regexp_replace(scope_key, ':[^:]*$', ''),
  key = regexp_replace(scope_key, '^.*:', '');


ALTER TABLE ops.idempotency_records
ALTER COLUMN scope
SET NOT NULL;


ALTER TABLE ops.idempotency_records
ALTER COLUMN key
SET NOT NULL;


-- 先撤唯一约束再删列：直接 drop column 会连带删掉约束，但留下的错误信息不如
-- 这两步清楚——将来有人回滚这份迁移时，能一眼看出顺序要求。
ALTER TABLE ops.idempotency_records
DROP CONSTRAINT idempotency_records_scope_key_key;


ALTER TABLE ops.idempotency_records
DROP COLUMN scope_key;


-- `id` 不在契约 §3 的列清单里，而一张表只能有一个主键。幂等记录的业务身份
-- 就是 (scope, key)——多一个代理主键等于给「同一格缓存」留第二种标识，回放时
-- 两处判定迟早不一致。先撤旧主键、再删列，最后按契约建新主键。
ALTER TABLE ops.idempotency_records
DROP CONSTRAINT idempotency_records_pkey;


ALTER TABLE ops.idempotency_records
DROP COLUMN id;


ALTER TABLE ops.idempotency_records
ADD CONSTRAINT idempotency_records_pkey PRIMARY KEY (scope, key);


-- `actor_id` 与审计表的 `actor_user_id` 指同一个东西（auth.users.id，也就是
-- `ops.operators.user_id`）。同一个概念两个名字，排障 join 时一定会错表。
ALTER TABLE ops.idempotency_records
RENAME COLUMN actor_id TO actor_user_id;


COMMENT ON COLUMN ops.idempotency_records.scope IS '由（验签后的 sub、组织、HTTP 方法、路径）拼接，不含客户端 key，也不含原始令牌（契约 §3「scope 的构成」）。';


COMMENT ON COLUMN ops.idempotency_records.key IS '客户端 Idempotency-Key 原值（8–128 字符 [A-Za-z0-9_-]）。与 scope 一起构成主键。';


COMMENT ON COLUMN ops.idempotency_records.actor_user_id IS '验签通过时的 auth.users.id（= ops.operators.user_id），仅供排障；不参与命名空间派生。';