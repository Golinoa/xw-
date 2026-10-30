-- 把幂等记录表对齐运营契约 §2.5 / §3 的列定义。
--
-- 三处差异都是命名层面的，不影响已有数据语义：
--   status -> response_status、body -> response_body 是契约用词，改名让契约 §3
--   的物理表清单与实际库一致，否则下次读契约的人会照着不存在的列写查询。
--   actor_id 是契约要求、我漏掉的列：它不参与命名空间派生（派生的调用者分量
--   已经以 `user:<sub>` 的形式进了 scope_key），只用于排障——「这格幂等缓存是
--   谁写进去的」在没有它的时候只能靠翻日志。
--
-- scope_key 保留单列、不拆成契约原本写的 `scope` + `key`：契约的 scope 示例是
-- `POST /api/v1/ops/receipts`，不含调用者，按字面实现会让两个运营成员在撞到
-- 同一个客户端 key 时共享缓存槽——后到的那个会拿到前一个的响应体。派生输入
-- 已改为（验签后的 sub, 组织, method, path, key），契约侧改写为「由调用者标识
-- 等四元组派生，具体算法由实现决定」。
ALTER TABLE ops.idempotency_records
RENAME COLUMN status TO response_status;


ALTER TABLE ops.idempotency_records
RENAME COLUMN body TO response_body;


ALTER TABLE ops.idempotency_records
ADD COLUMN actor_id uuid;


COMMENT ON COLUMN ops.idempotency_records.scope_key IS '由（验签后的 sub, 组织, method, path, Idempotency-Key）拼接后存原文，不含原始令牌。';


COMMENT ON COLUMN ops.idempotency_records.actor_id IS '验签通过时的 auth.users.id，仅用于排障；不参与命名空间派生。';