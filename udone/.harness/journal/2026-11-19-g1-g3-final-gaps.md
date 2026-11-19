# 2026-11-19 最后三个代码缺口（G1–G3）

来源：盘点后确认「代码层还剩 3 个真缺口」。按影响顺序做完。

## G1 供应商编辑 / 停用
- 现状比线路/来源更彻底：**契约里没有 `updateSupplier`，API 没有 PATCH，页面自己写着
  「停用、编辑与删除校验暂未开放」**。供应商信息填错了只能删了重建，而删除还可能
  被应付行引用卡住（409 OBJECT_REFERENCED）——等于没有维护手段。
- 契约补 `PATCH /api/suppliers/:supplierId`；仓储 `update()` **只提交传了的字段**。
  这一步最容易写错：用 `?? null` 统一兜底会把没传的联系人、电话、备注一次清空。
- 表单加编辑态（空值发 `null` 才清空），列表加 编辑 / 启停 / 删除；
  删除被引用时前端把 409 OBJECT_REFERENCED 翻成「只能停用」，不与「删除失败」混为一谈。
- 权限边界实测：`admin` 与 `operator` 有 `supplier.write`，**`finance` 只有 read**。

## G2 审批申请的明细名称快照
- 背景：B1 那次「脱钩」把删行改成置空外键，申请还在、费用名丢了，API 只能显示
  「（明细已删除）」。财务事后核账看不出这笔钱是什么费用。
- 新迁移加 `finance_applications.line_name`，用 **BEFORE INSERT 触发器**快照。
  没去改 `create_finance_application` 函数体：那要把整段复制一遍，以后改字段得同步两处。
- 存量数据回填：还挂着明细的取名；已脱钩的保持 NULL，不编造。
- API 装配改成 `row.line_name ?? 行表名称 ?? '（明细已删除）'`：
  优先信申请自己的快照，行表只是兼容旧数据。
- pgTAP 在「明细已删、申请还在」之后断言 `line_name = '团款'`。

## G3 PostgREST 404 可诊断
- 现状：RPC 不存在（迁移没应用）时统一落 500「服务暂时不可用」，排查只能人工比对迁移清单。
- `rest-client` 区分 `RestMissingResourceError`：HTTP 404 或 PostgREST `PGRST202/PGRST205`。
- `errorHandler` 对客户端仍是 500 + 通用文案（不泄漏内部结构），但：
  - 服务端日志写 `[dependency-missing] resource=rpc/xxx`；
  - 响应 `details.dependency` 带出资源名，看日志/请求的人一步定位。
- 单测同时钉住「未知错误不能泄漏内部信息」。

## 门禁
- pgTAP：**50 文件**（迁移 61 个；`finance_application_history` 20 断言）
- HTTP 集成：**34 文件 / 455 用例**（新增 `suppliers` 5 条）
- Vitest：**74 文件 / 924 用例**
- E2E：受影响的两个 spec 全过（admin-surfaces 9、master-data 5）
- tsc + vue-tsc、ESLint、CSS token、`schema:check`、生产构建

## 仍未做（都是已决策延后，不是遗漏）
订单回收站/恢复端点（业务端没有删除订单入口）、订单 restore 权限口径改判、
`vendor-antd` 体积、SYNC 502 产生端。需要用户的是：供应商 387/用户 90 的密码、D2 流水线确认。
