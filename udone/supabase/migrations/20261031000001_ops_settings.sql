-- 运营参数表：三行业务可配置值（契约 §3.9、§5.9 的 `settings.manage`）。
--
-- 为什么先落表、不落端点：这张表被三个域引用——`overview` 的临期窗口（o-t13）、
-- 工单的内部时限（o-t12 的 `isOverdue`）、导出的保留天数（o-t13）。按域落地的话，
-- `o-t12` 会先造一张替身表、`o-t13` 再把它换成真表，中间那版替身还要写一套
-- 迁移与回滚。表本身只有四列，先落没有额外成本。
--
-- 端点（`GET/PATCH /settings`）仍归 `o-t13`：读要 `settings.manage`，写要范围校验
-- 与审计，那是设置页整体的一部分，不是这张表的一部分。本轮只提供内部读取函数，
-- 供其它域的 RPC 调用。
--
-- 三个默认值都是**推导**，契约只给了范围没给初值：
--   - `overview.expiryWindowDays` = 30：§5.9 的临期权益行写着「默认 30」。
--   - `ticket.dueHours` = 48：§11 的 U-11 只给了「可配置」，48 小时对「首次响应」
--     是常见值，且落在 1–720 范围内。工单域落地时要与运营端确认优先级系数。
--   - `retention.exportDays` = 90：U-21 定了范围 1–365，没给初值；90 天与多数
--     财务导出留存口径一致。三条都记进规格与看板，作为待确认项。
CREATE TABLE ops.settings (
  -- key 用白名单而非自由文本：表里多一个键，就意味着有一个域在偷偷加配置项，
  -- 而契约没写、前端也没有入口。加键必须改本迁移，改动可见。
  key text PRIMARY KEY CHECK (
    key IN (
      'overview.expiryWindowDays',
      'ticket.dueHours',
      'retention.exportDays'
    )
  ),
  -- 值域校验写成表约束，不只在 RPC 里判：这张表的写入方将来会有 `PATCH /settings`，
  -- 也会有迁移里的种子行，约束是唯一能同时管住两处的地方。
  -- `jsonb_typeof = 'number'` 之外还要卡「纯整数」：`30.5` 也是 number，但
  -- 天数与小时数是整数语义，半个导出日没有意义，直接挡在库层。
  value jsonb NOT NULL CHECK (
    jsonb_typeof(value) = 'number'
    AND (value)::text ~ '^[0-9]+$'
    AND (value)::text::integer BETWEEN 1 AND (
      CASE
        WHEN key = 'ticket.dueHours' THEN 720
        ELSE 365
      END
    )
  ),
  updated_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);


INSERT INTO
  ops.settings (key, value)
VALUES
  ('overview.expiryWindowDays', '30'::jsonb),
  ('ticket.dueHours', '48'::jsonb),
  ('retention.exportDays', '90'::jsonb);


-- 内部读值函数：给其它域的 RPC 用，不暴露给 authenticated。
--
-- 两个参数（key + 默认值）而不是一个参数：表里缺行时返回默认值，比让调用方
-- `coalesce(null, 30)` 更安全——调用方会忘。默认值由调用方给，是因为「窗口缺省
-- 多少天」是域知识，不该由参数表反过来规定。
--
-- `stable` 不是 `immutable`：值会经 `PATCH /settings` 变，标成 immutable 会让
-- 优化器在语句内缓存，改了设置同一语句里还读旧值。
CREATE OR REPLACE FUNCTION ops.setting_int (p_key text, p_default integer) returns integer language sql stable security definer
SET
  search_path = '' AS $$
  select coalesce(
    (
      select (setting.value)::text::integer
      from ops.settings as setting
      where setting.key = p_key
    ),
    p_default
  );
$$;


REVOKE ALL ON TABLE ops.settings
FROM
  public,
  anon,
  authenticated;


ALTER TABLE ops.settings ENABLE ROW LEVEL SECURITY;


-- 连 EXECUTE 也撤：`setting_int` 只给 SECURITY DEFINER 的兄弟函数调，
-- 那些函数以 owner 身份运行，不需要经过 authenticated 的权限检查。
-- 留给 authenticated 的唯一后果是多一个能读配置的入口，而配置里将来会有阈值。
REVOKE ALL ON function ops.setting_int (text, integer)
FROM
  public,
  anon,
  authenticated;


COMMENT ON TABLE ops.settings IS '运营可配置参数（契约 §3.9）。三个键白名单固定在表约束里；值域 1–365 天 / 1–720 小时，越界在库层拒绝。端点归 o-t13。';


COMMENT ON function ops.setting_int (text, integer) IS '读整数配置项，缺行返回调用方给的默认值。stable 而非 immutable：值可经 PATCH /settings 变化。';