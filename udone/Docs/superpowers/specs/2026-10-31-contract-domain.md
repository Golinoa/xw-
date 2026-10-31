# contract 域规格（T-06 / `o-t06`）—— 两个子会话共读的唯一口径

契约真源：`ERP-ops/admin/Docs/ops-api-contract.md` §3.3（5 表 + 状态机）、§5.4（**14** 端点）、§7.3（A2 归类）、§7.4（拒绝路径）、U-13（附件存储）。

> 端点数已用 `awk` 精确核对 §5.4 表格行数：**14 条**（不是 13）。catalog 域是 13、客户域是 11，本域 14。

本轮只做合同域。应收（T-07）、订阅权益（T-09）、租户（T-10）、部署（T-11）、工单（T-12）不在本轮。
但本域的 `receivableSummary`、`impact{...}`、`entitlementPreview[]` 需要**引用尚未存在的表**——
处理方式在 §5 写死，不要自己发明。

## 0. 边界（越界即冲突）

| 谁 | 只许改这些文件 |
|---|---|
| DB 会话 | `supabase/migrations/20261030000010_ops_contract_domain.sql`、`supabase/tests/ops_contract_domain.sql` |
| API 会话 | `packages/contracts/src/ops/contracts.ts`（新建）、`packages/contracts/src/ops/index.ts`（加一行 export）、`packages/contracts/src/ops/audit-actions.ts`（追加 8 个词）、`packages/contracts/src/routes.ts`（在 `OPS_ROUTES` 末尾追加 14 条）、`apps/api/src/modules/ops/contracts/{protocol.ts,routes.ts,routes.test.ts}`（新建）、`apps/api/src/index.ts`（挂载，接在 catalog 之后） |

`packages/contracts/src/routes.ts` 与 `apps/api/src/index.ts` 是**全局共享写点**：本轮只有 API 会话能改，
另一个并行会话（做 a5/b1/b2/d1 四张债卡）不碰这两处，所以不冲突。但 API 会话自己要**最后再改这两处**
（先写完 14 个端点，最后一次性追加），避免中间态 typecheck 长时间红。

集成测试（`tests/integration/ops-contracts.test.ts`）由编排方写，两个会话都不要碰。
不要改 `2026103000000{1..9}` 任何迁移，不要改客户域 / catalog 域 / 身份域代码。

## 1. 表（照契约 §3.3；标「推断」的是契约没写死、本轮定的）

五张表，全部 `ops.` schema。

1. `ops.contracts`：`id uuid pk`、`contract_no text NOT NULL`、`customer_id uuid NOT NULL REFERENCES ops.customers(id) ON DELETE RESTRICT`、
   `sales_owner_operator_id uuid REFERENCES ops.operators(id) ON DELETE SET NULL`、
   `sales_mode text NOT NULL CHECK IN ('saas','private')`、`currency char(3) NOT NULL DEFAULT 'CNY'`、
   `total_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0)`、
   `payment_terms text`、`tax_note text`、`business_note text`、
   `status text NOT NULL CHECK IN ('draft','reviewing','signed','active','expired','terminated')`、
   `signed_on date`、`effective_on date`、`expires_on date`、
   `renewed_from_contract_id uuid REFERENCES ops.contracts(id) ON DELETE SET NULL`、
   `status_reason text`、`current_version_no int NOT NULL DEFAULT 0`、
   `version int NOT NULL DEFAULT 1`、审计列（与客户域同形）。
   `UNIQUE(contract_no)`、`CHECK(expires_on IS NULL OR effective_on IS NULL OR expires_on >= effective_on)`、
   `INDEX(customer_id, status)`、`INDEX(status, expires_on)`、`INDEX(sales_owner_operator_id)`。
   `contract_no` 默认 `HT-` + 6 位零填充序号（与客户域 `CUS-` 同机制、同序列风格）。
   **注意 `current_version_no` 默认 0 而不是 1**：契约原文是 `DEFAULT 1`，但 `draft` 阶段还没有任何
   `contract_versions` 行，默认 1 会让「有 1 个版本」和「没有版本」无法区分。本轮定 0，`activate` 时写 1。
   这一条要写进迁移头注释与卡片未验证项，联调时跟运营端确认。

2. `ops.contract_items`：`id`、`contract_id uuid NOT NULL REFERENCES contracts ON DELETE CASCADE`、
   `product_id uuid REFERENCES ops.products(id) ON DELETE RESTRICT`、
   `package_id uuid REFERENCES ops.packages(id) ON DELETE RESTRICT`、
   `package_price_version_id uuid REFERENCES ops.package_price_versions(id) ON DELETE RESTRICT`、
   `sales_mode text NOT NULL`、`billing_type text NOT NULL CHECK IN ('periodic','fixed_term','one_time')`、
   `quantity int NOT NULL DEFAULT 1 CHECK (quantity > 0)`、
   `unit_price numeric(14,2) NOT NULL CHECK (unit_price >= 0)`、
   `amount numeric(14,2) NOT NULL CHECK (amount >= 0)`、
   `term_months int`、`entitlement_snapshot_id uuid`（**软引用**，不加 FK——`ops.entitlement_snapshots` 属 T-09，
   本轮不存在；加 FK 会让 T-09 的迁移顺序被本域绑死）、`item_name_snapshot text NOT NULL`、
   `line_no int NOT NULL`、`version int NOT NULL DEFAULT 1`、审计列。
   `CHECK(amount = quantity * unit_price)`（**必须真建**，这是「服务端重算」的最后一道闸）、
   `UNIQUE(contract_id, line_no)`。契约写的 `UNIQUE(contract_id, id)` 是冗余约束（id 已全局唯一），不建。

3. `ops.contract_versions`：`id`、`contract_id uuid NOT NULL REFERENCES contracts ON DELETE CASCADE`、
   `version_no int NOT NULL CHECK (version_no > 0)`、`snapshot jsonb NOT NULL`、
   `created_by uuid REFERENCES operators(id) ON DELETE SET NULL`、
   `created_at timestamptz NOT NULL DEFAULT now()`、`change_reason text NOT NULL`。
   `UNIQUE(contract_id, version_no)`。**仅 INSERT**：不建 UPDATE/DELETE RPC，撤表级写权限。

4. `ops.contract_amendments`：`id`、`contract_id uuid NOT NULL REFERENCES contracts ON DELETE CASCADE`、
   `amendment_no int NOT NULL CHECK (amendment_no > 0)`、`reason text NOT NULL`、
   `before_summary jsonb NOT NULL`、`after_summary jsonb NOT NULL`、
   `status text NOT NULL CHECK IN ('draft','pending_approval','approved','rejected','applied')`、
   `requested_by uuid REFERENCES operators(id) ON DELETE SET NULL`、
   `approved_by uuid REFERENCES operators(id) ON DELETE SET NULL`、`approved_at timestamptz`、
   `applied_version_no int`、`version int NOT NULL DEFAULT 1`、审计列。
   `UNIQUE(contract_id, amendment_no)`、`CHECK(approved_by IS NULL OR approved_by <> requested_by)`（职责分离）。

5. `ops.contract_attachments`：`id`、`contract_id uuid NOT NULL REFERENCES contracts ON DELETE CASCADE`、
   `file_name text NOT NULL`、`content_type text NOT NULL`、`byte_size bigint NOT NULL`、
   `storage_path text NOT NULL`、`checksum_sha256 text`、
   `status text NOT NULL CHECK IN ('pending','stored')`（契约 §3.3 没这一列，**推断**：
   §5.4 的 `POST attachments` 返回 `status='pending'`、`complete` 返回 `status='stored'`，
   没有状态列就无法表达这两步，必须补）、
   `uploaded_by uuid REFERENCES operators(id) ON DELETE SET NULL`、
   `uploaded_at timestamptz NOT NULL DEFAULT now()`、
   `access_scope text NOT NULL DEFAULT 'contract.read'`、`version int NOT NULL DEFAULT 1`。
   `UNIQUE(storage_path)`、`CHECK(byte_size > 0 AND byte_size <= 26214400)`、`INDEX(contract_id)`。

RLS 与授权：五张表全部 `ENABLE ROW LEVEL SECURITY` 且**不建策略**，
`REVOKE ALL ON TABLE ... FROM public, anon, authenticated`。理由与客户域/catalog 域一致（读也走 RPC）。
契约 §7.3 把 `ops.contracts` 归「RPC / 可变（状态机约束）」，与 RPC-only 一致，不需要额外解释。

## 2. 状态机（7 条边，照契约 §3.3 表格，一条不多一条不少）

| 当前 | 动作 | 目标 | 权限码 | 守卫（不过就返回信封，不 RAISE） |
|---|---|---|---|---|
| `draft` | `submit` | `reviewing` | `contract.write` | 至少一条条目；`total_amount` 等于条目合计；客户 `status IN ('signed','onboarding','active')` |
| `reviewing` | `withdraw` | `draft` | `contract.write` | 无 |
| `reviewing` | `sign` | `signed` | `contract.approve` | 需 `signed_on`；`sales_mode` 必须在 `product_sales_modes.is_enabled` 中（**本条要真查表**，catalog 域已落地，不许跳过） |
| `signed` | `activate` | `active` | `contract.approve` | 需 `effective_on`；写 `contract_versions` 第 1 版快照 |
| `active` | `terminate` | `terminated` | `contract.approve` | 需 `reason`；`confirmImpact=true`；有活跃应收/订阅/租户命令时返回 `OBJECT_REFERENCED` |
| `active`/`signed` | `expire` | `expired` | `contract.approve` | 无额外守卫（到期或人工标记） |
| `expired`/`terminated` | — | 终态 | — | 任何动作都返回 `invalid_transition` |

不合法边一律 `{status:'invalid_transition', current, action}`，**不要** `RAISE`。
权限不足才是 42501，由 `ops.require_permission` 抛（与既有写法一致）。

`PATCH /contracts/{id}` 只允许 `status IN ('draft','reviewing')`，否则
`{status:'contract_immutable', status:<当前>}` → 409 `STATE_CONFLICT` + `details.reason='CONTRACT_IMMUTABLE'`。

## 3. 端点（14 个，照契约 §5.4，一条不多一条不少）

| # | 端点 | RPC | 成功码 | 幂等 |
|---|---|---|---|---|
| 1 | `GET /contracts` | `ops.list_contracts(p_keyword,p_customer_id,p_statuses,p_owner,p_expires_from,p_expires_to,p_sales_mode,p_page,p_page_size)` | 200 | — |
| 2 | `POST /contracts` | `ops.create_contract(p_customer_id,p_sales_mode,p_currency,p_payment_terms,p_tax_note,p_business_note,p_items jsonb)` | 201 | 必填 |
| 3 | `GET /contracts/{id}` | `ops.get_contract(p_contract_id)` | 200 | — |
| 4 | `PATCH /contracts/{id}` | `ops.update_contract(p_contract_id,p_expected_version,p_payment_terms,p_tax_note,p_business_note,p_expires_on,p_items jsonb,p_items_provided boolean)` | 200 | 必填 |
| 5 | `POST /contracts/{id}/transition` | `ops.transition_contract(p_contract_id,p_action,p_reason,p_signed_on,p_effective_on,p_confirm_impact,p_expected_version)` | 200 | 必填 |
| 6 | `GET /contracts/{id}/versions` | `ops.list_contract_versions(p_contract_id)` | 200 | — |
| 7 | `POST /contracts/{id}/amendments` | `ops.create_contract_amendment(p_contract_id,p_reason,p_header jsonb,p_items jsonb,p_header_provided boolean,p_items_provided boolean)` | 201 | 必填 |
| 8 | `POST /contracts/{id}/amendments/{aid}/transition` | `ops.transition_contract_amendment(p_amendment_id,p_action,p_reason,p_expected_version)` | 200 | 必填 |
| 9 | `POST /contracts/{id}/renewals` | `ops.renew_contract(p_contract_id,p_effective_on,p_expires_on,p_items jsonb,p_reason,p_force)` | 201 | 必填 |
| 10 | `GET /contracts/{id}/entitlement-preview` | `ops.contract_entitlement_preview(p_contract_id)` | 200 | — |
| 11 | `GET /contracts/{id}/attachments` | `ops.list_contract_attachments(p_contract_id)` | 200 | — |
| 12 | `POST /contracts/{id}/attachments` | `ops.create_contract_attachment(p_contract_id,p_file_name,p_content_type,p_byte_size)` | 201 | 必填 |
| 13 | `POST /contract-attachments/{aid}/complete` | `ops.complete_contract_attachment(p_attachment_id,p_checksum_sha256)` | 200 | 必填 |
| 14 | `GET /contract-attachments/{aid}/access` | `ops.contract_attachment_access(p_attachment_id)` | 200 | — |

**14 个 RPC 一一对应 14 个端点**，没有复用。`access` 与 `complete` 都是独立路径（`/contract-attachments/{id}/...`），
不在 `/contracts/{id}/` 前缀下——注册 `OPS_ROUTES` 时注意前缀不同，写错了就是 404 而不是类型错误。

## 4. 金额与快照的算法（最容易出错的地方）

- **入站不收 amount**：`items[]` 只收 `productId/packageId/priceVersionId/quantity/unitPrice/termMonths`。
  `amount = quantity * unit_price`、`total_amount = sum(amount)` **一律由 SQL 重算**，不信客户端。
  CHECK 约束是第二道闸，不是第一道。
- **`unit_price` 缺省从价格版本取**：给了 `priceVersionId` 但没给 `unitPrice` 时，
  服务端读 `ops.package_price_versions.price` 填入。两者都给且不一致 → `{status:'price_mismatch'}`（400）。
- **`item_name_snapshot`**：取套餐的 `customer_name`（空则 `internal_name`），建行时定格，之后套餐改名不影响。
- **`contract_versions.snapshot`** 形状（activate 与 amendment applied 都写）：
  ```json
  {"contract":{...合同全字段...},"items":[{...条目全字段...}],"entitlementLines":[{...}]}
  ```
  `entitlementLines` 在 `ops.entitlement_snapshots` 不存在时为空数组 `[]`（不要写 `null`——
  `null` 与「没有权益」不可区分，空数组才是「此刻没有」）。
- **`renewed_from_contract_id`**：续约建**新**合同（`draft`），不复用原合同行；原合同不动。

## 5. 引用未落地表的三处（写死，不要自己发明）

`ops.receivables`、`ops.subscriptions`、`ops.tenant_commands` 属 T-07/T-09/T-10，本轮不存在。
统一用一个函数封住：

```sql
-- 返回该合同在各未落地域里的引用计数；表不存在时对应键为 0
create or replace function ops.contract_reference_counts(p_contract_id uuid)
returns jsonb ...
-- → {"receivables":0,"entitlements":0,"tenantCommands":0}
```

实现用 `to_regclass('ops.receivables') IS NOT NULL` 守卫 + `EXECUTE format(...)` 动态 SQL
（与 catalog 域 `ops.catalog_reference_counts` 同写法）。**不许**直接 `SELECT ... FROM ops.receivables`
——迁移会在表还不存在时炸，而且 T-07 落地后这里要自动生效，不需要改本域代码。

`GET /contracts/{id}` 的 `receivables[]`、`subscriptions[]`、`licenses[]`、`attachments[]`：
前三个在表不存在时返回 `[]`（不是 null），`attachments[]` 本轮真查。

`terminate` 的 `OBJECT_REFERENCED`：三个计数**全为 0** 时放行；任一 > 0 返回
`{status:'referenced', impact:{...}}` → 409 `OBJECT_REFERENCED` + `details.impact`。
本轮因为三张表都不存在，这条分支**只能靠 pgTAP 建临时替身表证明**（与客户域同做法）。

## 6. entitlement-preview（本域与 catalog 的唯一耦合点）

读合同条目 → `package_id` → `ops.package_features` join `ops.feature_definitions`，
按 `feature_key` 合并（同键多条时 `quota` 取最大、`enabled` 取 AND、`termMonths` 取最大），
输出 `features[{featureKey,displayName,enabled,quota,termMonths,appliesTo}]`。

`warnings[]` 本轮只出一种：条目的套餐 `status <> 'active'` 时
`{code:'PACKAGE_NOT_ACTIVE', packageId}`。**不要**编造别的 warning 码。

条目没有 `package_id`（只写了产品）时该条目不产出行，且不报错——契约没规定，静默跳过并写进未验证项。

## 7. HTTP / 错误码映射

| 信封 status | HTTP | code | details |
|---|---|---|---|
| `ok` | 200/201 | — | — |
| `invalid_transition` | 409 | `STATE_CONFLICT` | `{reason:'INVALID_TRANSITION',current,action}` |
| `contract_immutable` | 409 | `STATE_CONFLICT` | `{reason:'CONTRACT_IMMUTABLE',status}` |
| `version_mismatch` | 409 | `CONFLICT` | `{currentVersion}` |
| `referenced` | 409 | `OBJECT_REFERENCED` | `{impact:{...}}` |
| `contract_no_conflict` | 409 | `CONFLICT` | `{field:'contractNo'}` |
| `customer_not_found` | 404 | `NOT_FOUND` | `{resource:'customer'}` |
| `contract_not_found` | 404 | `NOT_FOUND` | `{resource:'contract'}` |
| `amendment_not_found` | 404 | `NOT_FOUND` | `{resource:'amendment'}` |
| `attachment_not_found` | 404 | `NOT_FOUND` | `{resource:'attachment'}` |
| `items_required` | 400 | `VALIDATION_ERROR` | `{field:'items'}` |
| `total_mismatch` | 400 | `VALIDATION_ERROR` | `{reason:'TOTAL_MISMATCH'}` |
| `sales_mode_disabled` | 400 | `VALIDATION_ERROR` | `{reason:'SALES_MODE_DISABLED',salesMode}` |
| `price_mismatch` | 400 | `VALIDATION_ERROR` | `{reason:'PRICE_MISMATCH'}` |
| `customer_not_eligible` | 400 | `VALIDATION_ERROR` | `{reason:'CUSTOMER_NOT_ELIGIBLE'}` |
| `renewal_not_due` | 409 | `STATE_CONFLICT` | `{reason:'RENEWAL_NOT_DUE'}`（`force=true` 可越过） |
| `amendment_conflict` | 409 | `CONFLICT` | `{field:'amendment'}` |
| `attachment_too_large` | 400 | `VALIDATION_ERROR` | `{reason:'ATTACHMENT_TOO_LARGE',maxBytes:26214400}` |
| `attachment_type_rejected` | 400 | `VALIDATION_ERROR` | `{reason:'ATTACHMENT_TYPE_REJECTED'}` |
| `attachment_not_uploaded` | 409 | `STATE_CONFLICT` | `{reason:'ATTACHMENT_NOT_UPLOADED'}` |

`INVALID_TRANSITION` / `CONTRACT_IMMUTABLE` / `RENEWAL_NOT_DUE` / `ATTACHMENT_*` 这四个词族
**不在契约 §6.4 现有词表**里，API 会话照上表实现，编排方统一记成协作项请运营端回写 §6.4。

## 8. 附件与 Storage 的边界（U-13）

本地 shim 没有 Supabase Storage，所以：

- **做**：附件表、三个端点、状态机 `pending → stored`、大小/类型校验、`storage_path` 生成规则
  `contracts/{contractId}/{attachmentId}/{fileName}`、`access_scope` 默认 `contract.read`。
- **不做真实对象校验**：`complete` 只校验 `checksum_sha256` 格式（64 hex，给了才校验）与
  `status='pending'`，**不**去 Storage 查对象是否存在（本地无 Storage；生产要在 complete 里
  补一次 HEAD，这条写进迁移注释与未验证项）。
- `uploadUrl` 由环境变量 `OPS_STORAGE_PUBLIC_URL` 拼：`{base}/storage/v1/object/upload/sign/ops-contracts/{storagePath}?token=...`。
  变量缺省时用 `http://127.0.0.1:54321`，`uploadExpiresAt = now() + 5 分钟`。
  测试只断言「URL 前缀正确 + 过期时间 ≤5 分钟 + 是未来时间」。
- 类型白名单：`application/pdf`、`image/png`、`image/jpeg`、`application/vnd.openxmlformats-officedocument.wordprocessingml.document`、
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`。不在白名单 → `attachment_type_rejected`。
  （契约只写「类型/大小超限」，没给白名单，**推断**，写进未验证项。）

## 9. 审计动作（追加到 `OPS_AUDIT_ACTIONS`，8 个词）

`contract.created`、`contract.updated`、`contract.transitioned`、`contract.version_created`、
`contract.amendment_created`、`contract.amendment_decided`、`contract.attachment_added`、`contract.renewed`。

前后摘要里 `contract.transitioned` 必须带 `{from,to,reason}`；
`contract.updated` 带 `{before:{...},after:{...}}`（只含变了的键，不要全字段转储）。

## 10. 权限码

已 seed 的有 `contract.read` / `contract.write` / `contract.approve`（见 §3 权限表）。
DB 会话**不要**自己 INSERT 权限码——先 `grep` 确认 `20261030000003_ops_identity*.sql` 是否已 seed，
缺哪个在报告里说明，由编排方补迁移。API 会话的 `requireOpsPermission` 照既有三个码写。

## 11. 自验清单（每个会话必须真跑，不许只写不跑）

DB 会话：
1. `node scripts/db/local-db.mjs verify` —— 全绿，记「N 迁移 / M 文件 / K 断言」
2. `pnpm format:sql:check`（红则 `format:sql:write`）
3. `pnpm schema:check`（红则 `schema:generate`，生成物算你的改动）
4. 变异验证一次：挑 `sign` 的 `sales_mode` 未启用守卫或 `submit` 的合计校验，改坏 → 确认 pgTAP 变红 → **必须复原并复跑确认绿**

API 会话：
1. `pnpm typecheck`
2. `pnpm vitest run apps/api/src/modules/ops/contracts`（记用例数）
3. `pnpm lint`、`pnpm format:check`
4. 变异验证一次：挑「缺 Idempotency-Key → 400」或「`version_mismatch` → `details.currentVersion`」，改坏 → 红 → **复原 → 复跑绿**

**pgTAP `plan(N)` 必须等于实际断言数**（门禁会比对，不等就红）。
