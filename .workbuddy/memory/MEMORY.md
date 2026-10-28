# 项目长期记忆（D:\Coding\ERP）

## 项目性质
ERP 工作区，当前主线是**「云策教务」教培系统**（yunceTaro / yunce-back / yunce-admin）之外的调研项目：
**泫蜗旅行 OMS（trip.lipseo.com，飞途旅游订单系统）真实站点调研 → 一比一复刻**。
需求与口径由用户拍板，技术实现自主完成。

## 调研成果位置（只读参考，不是本系统代码）
- 主文档：`erp/docs/TRAVEL_OMS_*.md`（7 份：AI_AGENT_DESIGN / API_DRAFT / DOCS_INDEX /
  MULTITENANT_DATA_MODEL / PRODUCT_CHARACTERISTICS / REQUIREMENTS / STATE_MACHINES）
- 调研入口：`erp/docs/research/README.md`
- 证据：`research/evidence/{network_*.json, pages/*.json}`（脱敏后）
- 接口目录：`research/ACTUAL_API_CATALOG.json`、功能覆盖 `research/FUNCTION_COVERAGE.json`、
  就绪度 `research/REPLICATION_READINESS.md`、清理链 `research/TEST_CHAIN.md`

## 读证据的硬规则（踩过坑）
1. **先按 requestId 去重再谈"抓到几条"**——阶段网络文件是累加快照，同一请求会在多个文件重复出现。
2. 判断"抓到响应"要看条目有没有 `status`/`response` 字段，不能只看 URL 出现过。
3. 目录里 `capture` 字段分四档：`wire-captured` / `wire-captured-request-only` /
   `ui-submitted-not-captured` / `ui-confirmed-no-wire`，**引用前先按这个分档，别只看 evidence 里的文件名**。
4. 已经降级过的旧结论：`POST /orders/{id}/confirm-booking` 的 `status=302` 无报文支撑（只有请求侧）。

## 仍未拿到的东西（卡在外部授权，不是能力问题）
- 数据库 schema / 迁移 / 服务端代码（只读授权，最高优先）
- 第二个租户账号（做跨租户负向隔离验证）
- 导入功能入口（全站至今未发现）
- 审批**驳回/撤回**完整 UI（单账号权限不足，`/reject` 403、`/withdraw`、`/undo` 404）

## 待用户/业务决策的两项残留
- 供应商 387 删不掉：回收站内 4 条「复刻调研_」订单的应付项目引用卡住；
  唯一路径是回收站「彻底删除」（不可逆），**须用户点头才执行，不要擅自做**。
- 测试用户 90：服务端拒删，现为「禁用」仍占配额，要产品侧决定。
