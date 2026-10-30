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
