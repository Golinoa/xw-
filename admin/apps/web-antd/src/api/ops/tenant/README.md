# tenant 域（tenant-integration）

对应契约 §5.7（`/api/v1/ops/tenant-mappings|tenant-commands`）。已实现：

- 映射：`GET|POST /tenant-mappings`、`GET|PATCH /tenant-mappings/{mappingId}`
- 命令：`POST /tenant-mappings/{mappingId}/commands`（202 + 受理体）、`GET /tenant-commands`、 `GET /tenant-commands/{commandId}`、`GET /tenant-commands/{commandId}/attempts`、 `POST /tenant-commands/{commandId}/retry`、`POST /tenant-commands/{commandId}/cancel`
- 页面：`views/ops/tenant-integration/mappings.vue`（映射列表 + 新建 + 详情抽屉）、 `commands.vue`（命令总览）、`components/command-detail-drawer.vue`（命令体 + 尝试记录）

实现要点（不可让步）：

1. 命令是**异步**的：202 只代表已受理，界面文案固定「已受理，结果待确认」，由 `views/ops/tenant-integration/command-feedback.ts` 统一生成。
2. `expectedSyncVersion` 必须来自映射详情（`mapping.syncVersion`）， `composeCommandInput()` 对缺失/非整数/负数直接拒绝，**不允许 0 兜底**。
3. 幂等键由表单在打开时生成一次（`createCommandIdempotencyKey()`），提交、失败重试、双击都复用；重试命令复用命令自身的 `idempotency_key`。
4. `SYNC_TARGET_UNAVAILABLE`（502）不是失败：命令仍 `pending`，按「已受理」展示。
5. `last_error_category='permanent'` 禁止重试（前端规则 + 409 `PERMANENT_ERROR` 映射双保险）。
6. 仅 `attempt_count === 0` 的 `pending` 命令可取消。
7. ops 只保存租户引用与状态摘要，页面不请求、不展示租户内订单/游客/员工明细。
