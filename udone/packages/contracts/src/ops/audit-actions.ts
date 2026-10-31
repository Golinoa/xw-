import { z } from 'zod';

/**
 * 审计动作词表（D-03）。
 *
 * 这张表是「审计页筛选下拉能出现的全集」：运营端从 `OPS_AUDIT_ACTIONS` 生成
 * 下拉项，服务端从同一份表写出动作词。两边各写一份的结果已经出现过一次——
 * `operator.updated` / `role.created` / `role.updated` 三个词在库里真实产生，
 * 却不在契约里，于是运营端只能翻全量列表去找。
 *
 * 每条都写清「哪个操作落哪个词」，因为词面本身猜不出来：
 * `operator.updated` 覆盖账号侧的全部改动（状态、角色、MFA、显示名），
 * `role.updated` 只覆盖「权限集合没变的角色编辑」，而权限真的变了就升级成
 * `role.permissions_changed`——两个词不重叠，靠命名看不出来。
 */
export const OPS_AUDIT_ACTIONS = [
  {
    code: 'operator.invited',
    description: '邀请账号：POST /operators/invitations 成功写入成员行时落这个词。',
  },
  {
    code: 'operator.updated',
    description:
      '改账号：PATCH /operators/{id} 改状态、角色、MFA 策略或显示名都落这个词，前后摘要带 status / displayName / roleCodes / mfaRequired / permissions。',
  },
  {
    code: 'role.created',
    description: '新建角色：POST /roles 成功写入角色行时落这个词。',
  },
  {
    code: 'role.updated',
    description: '改角色定义：角色名、描述或启停发生变化、而权限集合没变时落这个词。',
  },
  {
    code: 'role.permissions_changed',
    description:
      '改角色权限：PATCH /roles/{id} 改变了权限集合时落这个词（同时改了名字也只落它，不再重复落 role.updated）。',
  },
  // 客户域，o-t04 新增，待运营端回写契约正文 §6.4。
  //
  // 四个词按「改的是哪一类东西」切开，不是按端点切：`customer.updated` 只覆盖
  // 客户主档的可编辑字段，状态迁移单独一个词（它带 from/to，按 `customer.updated`
  // 筛会把「改了备注」与「终止了客户」混在一起）。
  {
    code: 'customer.created',
    description:
      '新建客户：POST /customers 成功写入客户行（含内嵌联系人）时落这个词，摘要带 customerNo / name / status / contactCount。',
  },
  {
    code: 'customer.updated',
    description:
      '改客户主档：PATCH /customers/{id} 改名称、信用代码、区域或备注时落这个词，前后摘要带 name / unifiedSocialCreditCode / regionCode / status / ownerOperatorId。状态与责任人不在可改范围内。',
  },
  {
    code: 'customer.transitioned',
    description:
      '客户状态迁移：POST /customers/{id}/transition 的每一条合法边都落这个词，前后摘要带 from/to 的 status 与 action（start_onboarding / activate / suspend / resume / terminate）。',
  },
  {
    code: 'customer.contact_changed',
    description:
      '联系人变更：联系人的新建、编辑、删除都落这个词，`entity_type` 为 `customer_contact`，摘要只带姓名与 isPrimary，不带电话/邮箱原值。',
  },
  // 产品目录，o-t05 新增，待运营端回写契约正文 §6.4。
  //
  // 八个词同样按「改的是哪一类东西」切开：`package.transitioned` 单独一个词，
  // 因为状态迁移带 from/to 与动作，混进 `package.updated` 之后按后者筛选会同时
  // 命中「改了套餐名」与「下架了套餐」。`feature.*` 的 `entity_type` 是 `feature`
  // （主键是 `feature_key`，没有 uuid）。
  {
    code: 'product.created',
    description:
      '新建产品：POST /products 成功写入产品行（含销售方式开关）时落这个词，摘要带 code / name / lifecycleStatus / salesModes。',
  },
  {
    code: 'product.updated',
    description:
      '改产品：PATCH /products/{productId} 改名称、描述、生命周期状态或销售方式时落这个词，前后摘要只带变更过的键。',
  },
  {
    code: 'package.created',
    description:
      '新建套餐：POST /packages 成功写入套餐行、权益行与首条价格版本时落这个词，摘要带 productId / internalName / salesMode / billingType / listPrice / priceVersionNo。',
  },
  {
    code: 'package.updated',
    description:
      '改套餐：PATCH /packages/{packageId} 改内部名、客户名或权益集合时落这个词，前后摘要只带变更过的键（权益摘要只带 featureKey 与 enabled）。',
  },
  {
    code: 'package.transitioned',
    description:
      '套餐状态迁移：POST /packages/{packageId}/transition 的每一条合法边都落这个词，前后摘要带 from/to 的 status 与 action（activate / retire）以及 reason。',
  },
  {
    code: 'package.price_version_created',
    description:
      '新建价格版本：POST /packages/{packageId}/price-versions 成功时落这个词，摘要带 versionNo / price / currency / termMonths / effectiveFrom；价格版本只 INSERT，没有 update/delete 词。',
  },
  {
    code: 'feature.created',
    description:
      '新建功能键：POST /features 成功写入定义行时落这个词，`entity_type` 为 `feature`，摘要带 featureKey / displayName / valueType / unit。',
  },
  {
    code: 'feature.updated',
    description:
      '改功能键：PATCH /features/{featureKey} 改显示名、单位、描述或启停时落这个词，`entity_type` 为 `feature`，前后摘要只带变更过的键。主键不可改。',
  },
  // 合同域，o-t06 新增，待运营端回写契约正文 §6.4（其中四个词族甚至不在 §6.4 现有词表里）。
  //
  // 八个词按「改的是哪一类东西」切开，与客户域 / catalog 同原则：状态迁移单独一个
  // 词（它带 from/to/action），混进 `contract.updated` 之后按后者筛选会同时命中
  // 「改了付款条件」与「终止了合同」。变更单的**创建**与**裁决**分成两个词，
  // 因为它们由不同的人做（申请是 `contract.write`、审批是 `contract.approve`），
  // 合成一个词会让「谁批的」只能靠摘要里的 operatorId 反推。
  {
    code: 'contract.created',
    description:
      '新建合同：POST /contracts 成功写入合同行与条目时落这个词，摘要带 contractNo / customerId / salesMode / itemCount / totalAmount。',
  },
  {
    code: 'contract.updated',
    description:
      '改合同：PATCH /contracts/{id} 改付款条件、税务备注、业务备注、到期日或条目集合时落这个词，前后摘要带 `{before:{…},after:{…}}` 且**只含变了的键**，不做全字段转储。',
  },
  {
    code: 'contract.transitioned',
    description:
      '合同状态迁移：POST /contracts/{id}/transition 的每一条合法边都落这个词，前后摘要带 `{from,to,reason}`（reason 必填，审计页直接展示）。',
  },
  {
    code: 'contract.version_created',
    description:
      '生成版本快照：`activate` 写第 1 版、变更单 `apply` 写后续版本时落这个词，摘要带 versionNo / changeReason。版本表只 INSERT。',
  },
  {
    code: 'contract.amendment_created',
    description:
      '新建变更单：POST /contracts/{id}/amendments 成功写入变更单行时落这个词，摘要带 amendmentNo / reason 与只含变了的键的 before/after 摘要。',
  },
  {
    code: 'contract.amendment_decided',
    description:
      '裁决变更单：POST /contracts/{id}/amendments/{aid}/transition 的 submit / approve / reject / apply 都落这个词，摘要带 amendmentNo / from / to / reason。',
  },
  {
    code: 'contract.attachment_added',
    description:
      '合同附件：`POST /contracts/{id}/attachments`（申请上传）与 `POST /contract-attachments/{id}/complete`（确认完成）都落这个词，摘要带 attachmentId / fileName / contentType / byteSize / status，不带 storage_path 的签名参数。',
  },
  {
    code: 'contract.renewed',
    description:
      '续约：POST /contracts/{id}/renewals 成功时落这个词，摘要带 sourceContractId / newContractId / effectiveOn / expiresOn；原合同不改，所以不落 contract.updated。',
  },
  // billing 下半，o-t08 新增，待运营端回写契约正文 §6.4。
  //
  // 收款链路的九个词按「这条流水是什么」切开，不是按端点切：一笔收款依次是
  // recorded → approved（或 rejected）→ reconciled，冲正是 reversed；核销的
  // 撤销单独一个词（`receipt.allocation_reversed`），`entity_type` 是
  // `receipt_allocation` 而不是 `receipt`——撤销的对象是那一条分配，不是整笔钱。
  //
  // `receipt.rejected` 的拼写由契约 §3.4 直接点名（「写审计 receipt.rejected」），
  // 其余八个按同一形态补齐；驳回**不改变收款状态**（仍是 recorded），所以
  // 「这笔单被驳回过」只能从审计里看到——这正是它必须单独一个词的原因。
  {
    code: 'receipt.recorded',
    description:
      '登记收款：POST /receipts 成功写入收款行时落这个词，摘要带 receiptNo / customerId / contractId / amount / currency / methodCode / status。',
  },
  {
    code: 'receipt.approved',
    description:
      '审核通过：POST /receipts/{id}/transition 的 approve 边，前后摘要带 status 与 approvedBy；登记人自审会被 403 挡住，走不到这里。',
  },
  {
    code: 'receipt.rejected',
    description:
      '驳回收款：POST /receipts/{id}/transition 的 reject 边，reason 必填并原样入库；状态不变（仍为 recorded），驳回事实只存在于审计里。',
  },
  {
    code: 'receipt.reconciled',
    description:
      '核销收款：POST /receipts/{id}/allocations 成功时落这个词（每核销一轮一条），摘要带 allocatedTotal 与 receivableIds；追加核销也是这个动作。',
  },
  {
    code: 'receipt.reversed',
    description:
      '冲正收款：POST /receipts/{id}/reverse 成功时落这个词，摘要带 from/to 与 amount；仍有有效核销时会先被 HAS_ALLOCATIONS 挡住。',
  },
  {
    code: 'receipt.allocation_reversed',
    description:
      '撤销核销：POST /receipt-allocations/{id}/reverse 成功时落这个词，`entity_type` 为 `receipt_allocation`，前后摘要带 reversedAmount 与所属 receiptId / receivableId。',
  },
  {
    code: 'refund.recorded',
    description:
      '登记退款：POST /refunds 成功写入退款行时落这个词，摘要带 refundNo / receiptId / amount / currency / status。',
  },
  {
    code: 'refund.approved',
    description:
      '审核退款：POST /refunds/{id}/transition 的 approve 边，摘要带 approvedTotal 与 receiptStatus——累计已审核退款额等于收款额时收款会迁到 refunded，这一步就发生在同一次调用里。',
  },
  {
    code: 'refund.cancelled',
    description:
      '取消退款：POST /refunds/{id}/transition 的 cancel 边，reason 必填；取消后这部分额度重新可退，所以它和 approved 是两个词而不是同一个词的两个值。',
  },
  // 权益域，o-t09 新增。订阅与授权各八个动作词——两张表共用一套状态机
  // （契约 §3.5），但 `entity_type` 不同，筛选「这台机器的授权被暂停过吗」
  // 和「这个租户的订阅被暂停过吗」是两种查询，不能合成一个词。
  //
  // 注意 `*.expired` 对应的是 `mark_expired` 这个**人工**动作，不是自然到期：
  // 到期是时间的结果，不是一次操作，写进审计只会让「谁按了什么」变成噪声。
  {
    code: 'subscription.created',
    description:
      '建订阅草案：POST /subscriptions 成功写入订阅行与首张快照时落这个词，摘要带 subscriptionNo / contractItemId / currentSnapshotId / status。',
  },
  {
    code: 'subscription.submitted',
    description:
      '提交订阅审批：POST /subscriptions/{id}/transition 的 submit 边，前后摘要带 status。',
  },
  {
    code: 'subscription.approved',
    description: '审批通过订阅：transition 的 approve 边，订阅从 pending_approval 迁到 active。',
  },
  {
    code: 'subscription.rejected',
    description:
      '驳回订阅：transition 的 reject 边，reason 必填；驳回后回到 draft 而不是终态——申请人是被要求改内容重提。',
  },
  {
    code: 'subscription.suspended',
    description:
      '暂停订阅：transition 的 suspend 边，reason 必填。本轮不下发命令（tenant_commands 属 o-t10），所以这次暂停只到运营侧为止。',
  },
  {
    code: 'subscription.resumed',
    description: '恢复订阅：transition 的 resume 边，reason 必填。',
  },
  {
    code: 'subscription.revoked',
    description: '撤销订阅：transition 的 revoke 边，reason 必填，属高风险动作（契约 §4）。',
  },
  {
    code: 'subscription.expired',
    description:
      '标记订阅到期：transition 的 mark_expired 边，守卫是 ends_on < today。自然到期不落这个词。',
  },
  {
    code: 'license.created',
    description:
      '建私有化授权草案：POST /licenses 成功写入授权行与首张快照时落这个词，摘要带 licenseNo / licenseMode / currentSnapshotId。',
  },
  {
    code: 'license.submitted',
    description: '提交授权审批：POST /licenses/{id}/transition 的 submit 边。',
  },
  {
    code: 'license.approved',
    description: '审批通过授权：transition 的 approve 边，授权从 pending_approval 迁到 active。',
  },
  {
    code: 'license.rejected',
    description: '驳回授权：transition 的 reject 边，reason 必填，回到 draft。',
  },
  {
    code: 'license.suspended',
    description: '暂停授权：transition 的 suspend 边，reason 必填。',
  },
  {
    code: 'license.resumed',
    description: '恢复授权：transition 的 resume 边，reason 必填。',
  },
  {
    code: 'license.revoked',
    description: '撤销授权：transition 的 revoke 边，reason 必填，属高风险动作。',
  },
  {
    code: 'license.expired',
    description: '标记授权到期：transition 的 mark_expired 边，守卫是 valid_to < today。',
  },
  {
    code: 'entitlement_change.requested',
    description:
      '提权益变更：POST /subscriptions|licenses/{id}/change-requests 成功时落这个词，前后摘要带完整权益行（before / after），是「谁改了什么」的唯一记录。',
  },
  {
    code: 'entitlement_change.approved',
    description:
      '批准权益变更：POST /entitlement-change-requests/{id}/transition 的 approve 边；申请人自批会被 403 挡住，走不到这里。',
  },
  {
    code: 'entitlement_change.rejected',
    description: '驳回权益变更：transition 的 reject 边，reason 必填。',
  },
  {
    code: 'entitlement_change.cancelled',
    description:
      '取消权益变更：transition 的 cancel 边。取消只需要 request 或 approve 之一——提单的人可以自己收回，审批人也可以否掉。',
  },
  {
    code: 'entitlement_change.retried',
    description:
      '重试权益变更：transition 的 retry 边，需 entitlement.execute + tenant.retry。命令表（o-t10）已落地，但权益域的 execute 还没接上下发，所以这条路径仍未走通。',
  },
  {
    code: 'entitlement_change.executed',
    description:
      '执行权益变更：transition 的 execute 边，订阅/授权的 current_snapshot_id 被换成 proposed，摘要带 changeType。',
  },
  {
    code: 'entitlement_snapshot.created',
    description:
      '发放权益快照：每次 create_snapshot 真的插入新行时落这个词（命中同内容的既有快照不落），摘要带 sourceType / sourceId / targetScope / contentHash / lineCount。',
  },
  {
    code: 'tenant_mapping.created',
    description:
      '建立租户映射：mappingStatus 恒为 pending，摘要带 mappingNo / customerId / productId / udoneOrganizationId。',
  },
  {
    code: 'tenant_mapping.updated',
    description:
      '修改租户映射：只记 udoneOrganizationId / externalRef 两个字段的前后值——其余列不通过 PATCH 改，写进来会让审计看起来动了很多实际没动的字段。',
  },
  {
    code: 'tenant_command.created',
    description:
      '登记租户命令：状态恒为 pending（「已受理」而非「已完成」），摘要带 commandNo / commandType / expectedSyncVersion / changeRequestId。',
  },
  {
    code: 'tenant_command.retried',
    description: '重试租户命令：failed → retrying，复用同一幂等键，不新建命令。永久错误不可重试。',
  },
  {
    code: 'tenant_command.cancelled',
    description:
      '取消租户命令：只有一次都没发出去过（attemptCount=0）才能取消；已发出的要收回走 revoke 命令。',
  },
  {
    code: 'tenant_command.succeeded',
    description: '租户命令下发成功：远端确认后才落这个词，同时 syncVersion +1、映射状态摘要更新。',
  },
  {
    code: 'tenant_command.failed',
    description: '租户命令下发失败：摘要带 errorCategory / errorCode；permanent 不排下一次重试。',
  },
  {
    code: 'tenant_command.timed_out',
    description:
      '租户命令下发超时：命令保持 pending（结果未知），attempts.outcome=timeout，必须先查远端状态再重试。',
  },
  // deployment 域，o-t11 新增，待运营端回写契约正文 §6.4。
  //
  // 四个词按「改的是哪一类东西」切开：建实例、改主档、推状态、登记升级。**登记
  // 升级单独一个词**，因为它改的是 `currentVersion`——按 `deployment.updated`
  // 筛会把「改了负责人」与「这台机器升到了 1.5.0」混在一起，而后者是这一域唯一
  // 会被客户拿来说事的事实。升级记录本身只 INSERT，所以没有 update/delete 词。
  {
    code: 'deployment.created',
    description:
      '登记部署实例：POST /deployments 成功写入实例行时落这个词，摘要带 instanceNo / customerId / name / deploymentType / currentVersion / licenseId。',
  },
  {
    code: 'deployment.updated',
    description:
      '改实例主档：PATCH /deployments/{id} 改名称、部署类型、环境标识、上线日期、维护到期、负责人、授权或合同时落这个词，前后摘要**只含变了的键**；`currentVersion` 不在可改范围内。',
  },
  {
    code: 'deployment.transitioned',
    description:
      '实例状态迁移：POST /deployments/{id}/transition 的每一条合法边都落这个词，reason 原样入库（`retire` 必填），前后摘要带 from/to 的 status 与 action。',
  },
  // 设置页，o-t13 新增。三个词按「改的是哪一张表」切：参数项是 `settings`，
  // 字典条目是 `dictionary_item`。参数项没有 created / deleted——它只有三行，
  // 由迁移植入，端点只能改值；字典条目有 created / updated，没有 deleted，
  // 因为停用（`isActive=false`）才是它的删除语义。
  {
    code: 'settings.updated',
    description:
      '改运营参数：PATCH /settings 成功时落这个词，前后摘要**只含变了的键**（camelCase，与请求体同名），entity_id 为空——参数项是三行，没有单一实体可指。',
  },
  {
    code: 'dictionary.item_created',
    description:
      '新增字典条目：POST /dictionaries/{code}/items 成功时落这个词，摘要带 dictionaryCode / value / label / sortOrder。',
  },
  {
    code: 'dictionary.item_updated',
    description:
      '改字典条目：PATCH /dictionary-items/{itemId} 改文案、排序或启停都落这个词，前后摘要带 value / label / sortOrder / isActive。改文案与改启停不拆词——审计要回答的问题是「谁动过这个条目」。',
  },
  {
    code: 'export.created',
    description:
      '发起导出：POST /exports 成功写入任务行时落这个词，`reason` 原样入库（U-17 要求必填），摘要带 exportNo / exportType / filters / status=queued。此时还不知道行数。',
  },
  {
    code: 'export.completed',
    description:
      '导出完成：任务从 running 迁到 succeeded 时落这个词，摘要带 exportNo / exportType / filters / rowCount。**filters 与 rowCount 分两条审计落**（T-13 要求这一条里有两者），因为创建时算不出行数。',
  },
  {
    code: 'export.failed',
    description:
      '导出失败：任务从 running 迁到 failed 时落这个词，reason 记失败分类（REQUESTER_LOST_PERMISSION / ROW_LIMIT_EXCEEDED / STORAGE_UNAVAILABLE / INTERNAL_ERROR）。`ops.exports` 没有失败原因列，这里是唯一记录处。',
  },
  {
    code: 'deployment_version.recorded',
    description:
      '登记升级结果：POST /deployments/{id}/version-records 成功时落这个词，`entity_type` 为 `deployment_version_record`，摘要带 instanceId / fromVersion / toVersion / result 与登记后的 currentVersion——失败与回滚的记录里这个值等于登记前的值，那正是「只有 succeeded 推进」的证据。',
  },
] as const;

/** 动作码的平铺列表。给筛选下拉、日志白名单这类「只要字符串」的地方用。 */
export const OPS_AUDIT_ACTION_CODES: string[] = OPS_AUDIT_ACTIONS.map((action) => action.code);

/**
 * 审计动作的筛选值，**刻意不是 `z.enum`**。
 *
 * 动作词会继续长（下一个域接进来就多几个），而 `z.enum` 会把「加一个词」变成
 * 「旧客户端 + 新动作 = 400」：运营端发的是自己那份常量表里的值，服务端只要
 * 还没发布新词，按枚举校验就会把一次合法的筛选请求判成非法输入。这里只约束
 * 形状（非空、长度上限与 `ops.audit_events.action` 的用法一致），全集由
 * `OPS_AUDIT_ACTIONS` 与数据库共同维护，校验不做第二份真理。
 */
export const opsAuditActionSchema = z.string().trim().max(120);

export type OpsAuditActionDefinition = (typeof OPS_AUDIT_ACTIONS)[number];
export type OpsAuditAction = z.infer<typeof opsAuditActionSchema>;
