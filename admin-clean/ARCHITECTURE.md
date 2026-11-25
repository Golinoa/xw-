# 有单软件运营后台架构

## 目标与系统边界

运营后台管理软件提供方的客户关系、商品、合同、账款、订阅/授权、交付和售后。旅行社员工、组织和经营数据仍由 `udone` 管理。运营系统不能绕过 `udone` API 直接改写旅行社业务。

## 请求路径

```text
Vben Vue 3 + Ant Design Vue 前端（本目录独立构建/发布）
  -> 版本化运营 API（由 udone 的 Hono Worker 承载）
  -> 运营领域应用服务
  -> Supabase PostgreSQL 专属 ops schema / RLS / 事务
  -> 受控租户交付命令
  -> udone 租户管理服务
```

运营前端与 `udone` 用户界面独立；API、Worker 和 Supabase 项目首期复用。前端只调用版本化 API，不直接访问受保护的数据库表。

## 模块依赖

- 前端按客户、商品、合同账款、订阅授权、租户交付、私有化部署、售后、运营配置和审计拆分路由/功能模块。
- 后端业务逻辑仍位于 `udone` 的单 Hono Worker；按 customer、catalog、contract、billing、entitlement、tenant-integration、deployment、support、identity/audit 领域组织。
- HTTP 路由处理认证上下文、输入验证、请求/响应和错误映射；应用服务处理用例编排；领域逻辑不依赖 Vue、Hono 或 Supabase SDK；数据库事务负责强一致不变量。
- 首期不拆微服务。只有独立扩缩容、故障隔离、安全隔离或可度量性能瓶颈证明有收益后，才重新评估拆分。

## 身份与数据边界

- 运营账号池与旅行社用户的角色/授权域逻辑分离，底层首期共用 Supabase Auth 项目。
- Supabase Auth 的用户命名空间仍是共享的；所谓账号池分离指运营成员关系和运营授权独立，不宣称有独立认证基础设施。
- `ops` schema 保存运营商业和交付数据；旅行社业务 schema 继续由 `udone` 控制。具体物理表、RPC 与 RLS 策略以 `udone/supabase/migrations/` 为准。
- 每个运营请求都验证 Auth 身份、运营成员有效状态和具体权限；API 与 RLS 双重拒绝未授权访问。
- `udone` 租户开通/停用/权益同步使用显式、版本化、幂等 API 命令；跨系统请求记录状态、请求 ID、关联合同/权益和安全摘要。

## 失败和一致性

- 合同、应收、收款、核销、退款、授权和审计采用数据库事务或等价原子边界。
- 跨系统命令使用幂等键和可查询状态；超时先查询结果再重试，失败不得伪装成已开通。
- 运营商业状态与 `udone` 租户运行状态分别保存，依靠受控同步状态关联，不以单一状态字段混用。
- 所有外部依赖由适配层接入；凭证仅保存在服务端 secret，不出现在前端构建产物。

## 权威来源

- [产品需求](Docs/PRD.md)
- [技术选型](Docs/TECH_SELECTION.md)
- 数据库迁移与实际 Hono API 仍以同级 `udone` 项目相应真源为准；运营端不能复制或猜测物理 schema。
