import type { z } from 'zod';
import { authContextSchema } from './auth';
import {
  createCustomerRequestSchema,
  createCustomerResponseSchema,
  createCustomerTagRequestSchema,
  customerDeletedResponseSchema,
  customerListQuerySchema,
  customerListResponseSchema,
  customerParamsSchema,
  customerResponseSchema,
  customerRestoredResponseSchema,
  customerSourceDeletedResponseSchema,
  customerSourceListResponseSchema,
  customerSourceParamsSchema,
  customerSourceResponseSchema,
  createCustomerSourceRequestSchema,
  updateCustomerSourceRequestSchema,
  customerTagListResponseSchema,
  customerTagResponseSchema,
  updateCustomerRequestSchema,
} from './customers';
import type { HttpMethod } from './http';
import {
  opsAuditEventListQuerySchema,
  opsAuditEventListResponseSchema,
  opsOperatorInvitationRequestSchema,
  opsOperatorInvitationResponseSchema,
  opsOperatorListQuerySchema,
  opsOperatorListResponseSchema,
  opsOperatorUpdateRequestSchema,
  opsOperatorUpdateResponseSchema,
  opsRoleCreateRequestSchema,
  opsRoleCreateResponseSchema,
  opsRoleListResponseSchema,
  opsRoleUpdateRequestSchema,
  opsRoleUpdateResponseSchema,
} from './ops/accounts';
import { opsLoginRequestSchema, opsLogoutResponseSchema, opsTokenResponseSchema } from './ops/auth';
import {
  opsFeatureCreateRequestSchema,
  opsFeatureListQuerySchema,
  opsFeatureListResponseSchema,
  opsFeatureResponseSchema,
  opsFeatureUpdateRequestSchema,
  opsPackageCreateRequestSchema,
  opsPackageCreateResponseSchema,
  opsPackageDetailResponseSchema,
  opsPackageListQuerySchema,
  opsPackageListResponseSchema,
  opsPackagePriceVersionCreateRequestSchema,
  opsPackagePriceVersionCreateResponseSchema,
  opsPackageTransitionRequestSchema,
  opsPackageTransitionResponseSchema,
  opsPackageUpdateRequestSchema,
  opsPackageUpdateResponseSchema,
  opsPriceVersionListResponseSchema,
  opsProductCreateRequestSchema,
  opsProductListQuerySchema,
  opsProductListResponseSchema,
  opsProductResponseSchema,
  opsProductUpdateRequestSchema,
} from './ops/catalog';
import {
  opsContractAmendmentCreateRequestSchema,
  opsContractAmendmentCreateResponseSchema,
  opsContractAmendmentTransitionRequestSchema,
  opsContractAmendmentTransitionResponseSchema,
  opsContractAttachmentAccessResponseSchema,
  opsContractAttachmentCompleteRequestSchema,
  opsContractAttachmentCompleteResponseSchema,
  opsContractAttachmentCreateRequestSchema,
  opsContractAttachmentCreateResponseSchema,
  opsContractAttachmentListResponseSchema,
  opsContractCreateRequestSchema,
  opsContractCreateResponseSchema,
  opsContractDetailResponseSchema,
  opsContractEntitlementPreviewResponseSchema,
  opsContractListQuerySchema,
  opsContractListResponseSchema,
  opsContractRenewalRequestSchema,
  opsContractRenewalResponseSchema,
  opsContractTransitionRequestSchema,
  opsContractTransitionResponseSchema,
  opsContractUpdateRequestSchema,
  opsContractUpdateResponseSchema,
  opsContractVersionListResponseSchema,
} from './ops/contracts';
import {
  opsCustomerContactCreateRequestSchema,
  opsCustomerContactDeleteResponseSchema,
  opsCustomerContactListResponseSchema,
  opsCustomerContactResponseSchema,
  opsCustomerContactUpdateRequestSchema,
  opsCustomerCreateRequestSchema,
  opsCustomerCreateResponseSchema,
  opsCustomerDetailResponseSchema,
  opsCustomerDuplicateCheckRequestSchema,
  opsCustomerDuplicateCheckResponseSchema,
  opsCustomerListQuerySchema,
  opsCustomerListResponseSchema,
  opsCustomerOverviewResponseSchema,
  opsCustomerTransitionRequestSchema,
  opsCustomerTransitionResponseSchema,
  opsCustomerUpdateRequestSchema,
  opsCustomerUpdateResponseSchema,
} from './ops/customers';
import {
  opsChangeRequestCreateRequestSchema,
  opsChangeRequestCreateResponseSchema,
  opsChangeRequestDetailResponseSchema,
  opsChangeRequestListQuerySchema,
  opsChangeRequestListResponseSchema,
  opsChangeRequestTransitionRequestSchema,
  opsChangeRequestTransitionResponseSchema,
  opsLicenseCreateRequestSchema,
  opsLicenseCreateResponseSchema,
  opsLicenseDetailResponseSchema,
  opsLicenseListQuerySchema,
  opsLicenseListResponseSchema,
  opsLicenseTransitionResponseSchema,
  opsSnapshotDetailResponseSchema,
  opsSnapshotListQuerySchema,
  opsSnapshotListResponseSchema,
  opsSubjectTransitionRequestSchema,
  opsSubscriptionCreateRequestSchema,
  opsSubscriptionCreateResponseSchema,
  opsSubscriptionDetailResponseSchema,
  opsSubscriptionListQuerySchema,
  opsSubscriptionListResponseSchema,
  opsSubscriptionTransitionResponseSchema,
} from './ops/entitlements';
import {
  opsDeploymentCreateRequestSchema,
  opsDeploymentCreateResponseSchema,
  opsDeploymentDetailResponseSchema,
  opsDeploymentListQuerySchema,
  opsDeploymentListResponseSchema,
  opsDeploymentTransitionRequestSchema,
  opsDeploymentTransitionResponseSchema,
  opsDeploymentUpdateRequestSchema,
  opsDeploymentUpdateResponseSchema,
  opsDeploymentVersionRecordCreateRequestSchema,
  opsDeploymentVersionRecordCreateResponseSchema,
  opsDeploymentVersionRecordListQuerySchema,
  opsDeploymentVersionRecordListResponseSchema,
} from './ops/deployment';
import { opsOverviewQuerySchema, opsOverviewResponseSchema } from './ops/overview';
import {
  opsDeploymentVersionReportQuerySchema,
  opsDeploymentVersionReportResponseSchema,
  opsExpiringEntitlementReportQuerySchema,
  opsExpiringEntitlementReportResponseSchema,
  opsReceivableReportQuerySchema,
  opsReceivableReportResponseSchema,
  opsTenantSyncFailureReportQuerySchema,
  opsTenantSyncFailureReportResponseSchema,
} from './ops/reports';
import {
  opsDictionaryItemCreateRequestSchema,
  opsDictionaryItemCreateResponseSchema,
  opsDictionaryItemUpdateRequestSchema,
  opsDictionaryItemUpdateResponseSchema,
  opsDictionaryListQuerySchema,
  opsDictionaryListResponseSchema,
  opsSettingsResponseSchema,
  opsSettingsUpdateRequestSchema,
} from './ops/settings';
import {
  opsExportCreateRequestSchema,
  opsExportCreateResponseSchema,
  opsExportDetailResponseSchema,
  opsExportListQuerySchema,
  opsExportListResponseSchema,
} from './ops/exports';
import {
  opsTenantCommandAttemptListResponseSchema,
  opsTenantCommandCreateRequestSchema,
  opsTenantCommandCreateResponseSchema,
  opsTenantCommandDetailResponseSchema,
  opsTenantCommandListQuerySchema,
  opsTenantCommandListResponseSchema,
  opsTenantCommandTransitionRequestSchema,
  opsTenantCommandTransitionResponseSchema,
  opsTenantMappingCreateRequestSchema,
  opsTenantMappingCreateResponseSchema,
  opsTenantMappingDetailResponseSchema,
  opsTenantMappingListQuerySchema,
  opsTenantMappingListResponseSchema,
  opsTenantMappingUpdateRequestSchema,
  opsTenantMappingUpdateResponseSchema,
} from './ops/tenant-integration';
import {
  opsReceivableDetailResponseSchema,
  opsReceivableExtensionCreateRequestSchema,
  opsReceivableExtensionCreateResponseSchema,
  opsReceivableListQuerySchema,
  opsReceivableListResponseSchema,
  opsReceivablePlanCreateRequestSchema,
  opsReceivablePlanCreateResponseSchema,
} from './ops/receivables';
import {
  opsReceiptAllocationCreateRequestSchema,
  opsReceiptAllocationCreateResponseSchema,
  opsReceiptAllocationReverseRequestSchema,
  opsReceiptAllocationReverseResponseSchema,
  opsReceiptCreateRequestSchema,
  opsReceiptCreateResponseSchema,
  opsReceiptDetailResponseSchema,
  opsReceiptListResponseSchema,
  opsReceiptReverseRequestSchema,
  opsReceiptReverseResponseSchema,
  opsReceiptTransitionRequestSchema,
  opsReceiptTransitionResponseSchema,
  opsRefundCreateRequestSchema,
  opsRefundCreateResponseSchema,
  opsRefundListResponseSchema,
  opsRefundTransitionRequestSchema,
  opsRefundTransitionResponseSchema,
} from './ops/receipts';
import {
  opsTicketAssignRequestSchema,
  opsTicketAssignableOperatorsResponseSchema,
  opsTicketCreateRequestSchema,
  opsTicketDetailResponseSchema,
  opsTicketEventCreateRequestSchema,
  opsTicketEventCreateResponseSchema,
  opsTicketListQuerySchema,
  opsTicketListResponseSchema,
  opsTicketReferenceCreateRequestSchema,
  opsTicketReferenceCreateResponseSchema,
  opsTicketResponseSchema,
  opsTicketTimelineResponseSchema,
  opsTicketTransitionRequestSchema,
  opsTicketUpdateRequestSchema,
  opsTicketWriteResponseSchema,
} from './ops/tickets';
import { opsMetaResponseSchema } from './ops/meta';
import { opsPermissionListResponseSchema, opsSessionResponseSchema } from './ops/session';
import {
  createFinanceApplicationRequestSchema,
  decideFinanceApplicationRequestSchema,
  financeApplicationDetailResponseSchema,
  financeApplicationListQuerySchema,
  financeApplicationListResponseSchema,
  financeApplicationParamsSchema,
  financeApplicationReasonRequestSchema,
  financeApplicationResponseSchema,
} from './finance-applications';
import {
  financeListQuerySchema,
  orderFinanceResponseSchema,
  payableListQuerySchema,
  payableListResponseSchema,
  receivableListResponseSchema,
} from './finance';
import {
  createOrderRequestSchema,
  orderListQuerySchema,
  orderListResponseSchema,
  orderParamsSchema,
  orderResponseSchema,
  transitionOrderRequestSchema,
  updateOrderRequestSchema,
} from './orders';
import {
  createSupplierRequestSchema,
  supplierListQuerySchema,
  supplierListResponseSchema,
  supplierResponseSchema,
} from './suppliers';
import { healthResponseSchema } from './health';
import {
  acceptInvitationResponseSchema,
  createOrganizationInvitationRequestSchema,
  invitationResponseSchema,
  memberListResponseSchema,
  memberUpdateResponseSchema,
  updateOrganizationMemberRequestSchema,
} from './members';
import {
  createOrganizationRequestSchema,
  createOrganizationResponseSchema,
  meResponseSchema,
} from './organizations';

/**
 * 单个 HTTP 端点的契约定义。
 *
 * `request` 是入站校验（API 侧解析、前端发送前自检），`response` 是出站校验
 * （API 侧由 respond() 校验、前端由 api client 解析）。两端共用同一份 schema，
 * 字段增删只改一处。
 */
export interface RouteContract {
  readonly method: HttpMethod;
  readonly path: string;
  readonly request?: z.ZodType;
  readonly response: z.ZodType;
}

export function defineRoute<T extends RouteContract>(contract: T): T {
  return contract;
}

/**
 * 所有对外端点的唯一清单。新增端点必须先在 `ROUTES` 注册，否则
 * `tests/contracts/route-parity.test.ts` 会因路由与清单不一致而失败。
 */
export const ROUTES = {
  health: defineRoute({
    method: 'GET',
    path: '/api/health',
    response: healthResponseSchema,
  }),
  me: defineRoute({
    method: 'GET',
    path: '/api/me',
    response: meResponseSchema,
  }),
  createOrganization: defineRoute({
    method: 'POST',
    path: '/api/organizations',
    request: createOrganizationRequestSchema,
    response: createOrganizationResponseSchema,
  }),
  switchOrganization: defineRoute({
    method: 'POST',
    path: '/api/organizations/:id/switch',
    response: authContextSchema,
  }),
  listMembers: defineRoute({
    method: 'GET',
    path: '/api/organizations/:id/members',
    response: memberListResponseSchema,
  }),
  inviteMember: defineRoute({
    method: 'POST',
    path: '/api/organizations/:id/invitations',
    request: createOrganizationInvitationRequestSchema,
    response: invitationResponseSchema,
  }),
  updateMember: defineRoute({
    method: 'PATCH',
    path: '/api/organizations/:id/members/:userId',
    request: updateOrganizationMemberRequestSchema,
    response: memberUpdateResponseSchema,
  }),
  acceptInvitation: defineRoute({
    method: 'POST',
    path: '/api/invitations/:invitationId/accept',
    response: acceptInvitationResponseSchema,
  }),
  listCustomers: defineRoute({
    method: 'GET',
    path: '/api/customers',
    request: customerListQuerySchema,
    response: customerListResponseSchema,
  }),
  createCustomer: defineRoute({
    method: 'POST',
    path: '/api/customers',
    request: createCustomerRequestSchema,
    response: createCustomerResponseSchema,
  }),
  getCustomer: defineRoute({
    method: 'GET',
    path: '/api/customers/:customerId',
    request: customerParamsSchema,
    response: customerResponseSchema,
  }),
  updateCustomer: defineRoute({
    method: 'PATCH',
    path: '/api/customers/:customerId',
    request: updateCustomerRequestSchema,
    response: customerResponseSchema,
  }),
  deleteCustomer: defineRoute({
    method: 'DELETE',
    path: '/api/customers/:customerId',
    request: customerParamsSchema,
    response: customerDeletedResponseSchema,
  }),
  /**
   * 回收站恢复。与删除对称，用 POST + 子路径表达「对既有资源施加一个动作」，
   * 而不是把已删除资源当成可 PATCH 的对象 —— 后者会让「改已删数据」也走同一条路。
   */
  restoreCustomer: defineRoute({
    method: 'POST',
    path: '/api/customers/:customerId/restore',
    request: customerParamsSchema,
    response: customerRestoredResponseSchema,
  }),
  listCustomerTags: defineRoute({
    method: 'GET',
    path: '/api/customer-tags',
    response: customerTagListResponseSchema,
  }),
  createCustomerTag: defineRoute({
    method: 'POST',
    path: '/api/customer-tags',
    request: createCustomerTagRequestSchema,
    response: customerTagResponseSchema,
  }),
  listCustomerSources: defineRoute({
    method: 'GET',
    path: '/api/customer-sources',
    response: customerSourceListResponseSchema,
  }),
  createCustomerSource: defineRoute({
    method: 'POST',
    path: '/api/customer-sources',
    request: createCustomerSourceRequestSchema,
    response: customerSourceResponseSchema,
  }),
  updateCustomerSource: defineRoute({
    method: 'PATCH',
    path: '/api/customer-sources/:sourceId',
    request: updateCustomerSourceRequestSchema,
    response: customerSourceResponseSchema,
  }),
  deleteCustomerSource: defineRoute({
    method: 'DELETE',
    path: '/api/customer-sources/:sourceId',
    request: customerSourceParamsSchema,
    response: customerSourceDeletedResponseSchema,
  }),
  listOrders: defineRoute({
    method: 'GET',
    path: '/api/orders',
    request: orderListQuerySchema,
    response: orderListResponseSchema,
  }),
  createOrder: defineRoute({
    method: 'POST',
    path: '/api/orders',
    request: createOrderRequestSchema,
    response: orderResponseSchema,
  }),
  getOrder: defineRoute({
    method: 'GET',
    path: '/api/orders/:orderId',
    request: orderParamsSchema,
    response: orderResponseSchema,
  }),
  updateOrder: defineRoute({
    method: 'PATCH',
    path: '/api/orders/:orderId',
    request: updateOrderRequestSchema,
    response: orderResponseSchema,
  }),
  transitionOrder: defineRoute({
    method: 'POST',
    path: '/api/orders/:orderId/transition',
    request: transitionOrderRequestSchema,
    response: orderResponseSchema,
  }),
  listSuppliers: defineRoute({
    method: 'GET',
    path: '/api/suppliers',
    request: supplierListQuerySchema,
    response: supplierListResponseSchema,
  }),
  createSupplier: defineRoute({
    method: 'POST',
    path: '/api/suppliers',
    request: createSupplierRequestSchema,
    response: supplierResponseSchema,
  }),
  getOrderFinance: defineRoute({
    method: 'GET',
    path: '/api/orders/:orderId/finance',
    request: orderParamsSchema,
    response: orderFinanceResponseSchema,
  }),
  listReceivables: defineRoute({
    method: 'GET',
    path: '/api/receivables',
    request: financeListQuerySchema,
    response: receivableListResponseSchema,
  }),
  listPayables: defineRoute({
    method: 'GET',
    path: '/api/payables',
    request: payableListQuerySchema,
    response: payableListResponseSchema,
  }),
  listFinanceApplications: defineRoute({
    method: 'GET',
    path: '/api/finance-applications',
    request: financeApplicationListQuerySchema,
    response: financeApplicationListResponseSchema,
  }),
  createFinanceApplication: defineRoute({
    method: 'POST',
    path: '/api/finance-applications',
    request: createFinanceApplicationRequestSchema,
    response: financeApplicationResponseSchema,
  }),
  getFinanceApplication: defineRoute({
    method: 'GET',
    path: '/api/finance-applications/:applicationId',
    request: financeApplicationParamsSchema,
    response: financeApplicationDetailResponseSchema,
  }),
  /** 通过或驳回。终审通过才把金额从在途挪进已收/已付。 */
  decideFinanceApplication: defineRoute({
    method: 'PATCH',
    path: '/api/finance-applications/:applicationId',
    request: decideFinanceApplicationRequestSchema,
    response: financeApplicationResponseSchema,
  }),
  withdrawFinanceApplication: defineRoute({
    method: 'POST',
    path: '/api/finance-applications/:applicationId/withdraw',
    request: financeApplicationReasonRequestSchema,
    response: financeApplicationResponseSchema,
  }),
  /** 撤销终审：把已确认金额退回在途，申请回到待审。 */
  undoFinanceApplication: defineRoute({
    method: 'POST',
    path: '/api/finance-applications/:applicationId/undo',
    request: financeApplicationReasonRequestSchema,
    response: financeApplicationResponseSchema,
  }),
} as const;

/**
 * 运营后台（`/api/v1/ops/*`）的端点清单。
 *
 * 与 `ROUTES` 分开是刻意的：两张表有不同的路径前缀、不同的鉴权体系（运营成员
 * 而不是租户成员）、不同的错误码词表。合成一张表会让「这条路由属于谁」变成
 * 需要读路径字符串才能回答的问题，而 `respond()` 的 key 恰恰是最容易抄错的东西。
 *
 * T-01 起逐个登记。第一条是 `GET /api/v1/ops/meta`——它是前端判断「对端是不是
 * 它以为的那个后端」的唯一入口，所以排在所有业务端点之前。
 */
export const OPS_ROUTES = {
  /**
   * 三个 `POST /auth/*` 是唯一不要求 `Authorization` 的运营端点（契约 §5.1）。
   * 它们排在清单最前面，是因为读契约的人先看到例外再看到规则，比反过来更容易
   * 记住「其余全部要令牌」。
   */
  postOpsLogin: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/auth/login',
    request: opsLoginRequestSchema,
    response: opsTokenResponseSchema,
  }),
  postOpsRefresh: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/auth/refresh',
    response: opsTokenResponseSchema,
  }),
  postOpsLogout: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/auth/logout',
    response: opsLogoutResponseSchema,
  }),
  getOpsMeta: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/meta',
    response: opsMetaResponseSchema,
  }),
  getOpsSession: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/session',
    response: opsSessionResponseSchema,
  }),
  listOpsPermissions: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/permissions',
    response: opsPermissionListResponseSchema,
  }),
  /**
   * 账号与角色写侧（契约 §5.1）。
   *
   * `POST /operators/invitations` 排在 `PATCH /operators/:operatorId` 之前是刻意的：
   * Hono 按注册顺序匹配，虽然两者方法不同不会真的撞车，但阅读顺序应当是
   * 「先看到集合上的动作，再看到单条上的动作」——反过来读会以为 invitations
   * 是某个 operatorId 的子资源。
   */
  listOpsOperators: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/operators',
    request: opsOperatorListQuerySchema,
    response: opsOperatorListResponseSchema,
  }),
  inviteOpsOperator: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/operators/invitations',
    request: opsOperatorInvitationRequestSchema,
    response: opsOperatorInvitationResponseSchema,
  }),
  updateOpsOperator: defineRoute({
    method: 'PATCH',
    path: '/api/v1/ops/operators/:operatorId',
    request: opsOperatorUpdateRequestSchema,
    response: opsOperatorUpdateResponseSchema,
  }),
  listOpsRoles: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/roles',
    response: opsRoleListResponseSchema,
  }),
  createOpsRole: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/roles',
    request: opsRoleCreateRequestSchema,
    response: opsRoleCreateResponseSchema,
  }),
  updateOpsRole: defineRoute({
    method: 'PATCH',
    path: '/api/v1/ops/roles/:roleId',
    request: opsRoleUpdateRequestSchema,
    response: opsRoleUpdateResponseSchema,
  }),
  listOpsAuditEvents: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/audit-events',
    request: opsAuditEventListQuerySchema,
    response: opsAuditEventListResponseSchema,
  }),
  /**
   * 客户与联系人（契约 §5.2，十一个端点）。
   *
   * 顺序照契约表：集合 → 集合上的动作（查重）→ 单条 → 单条上的子资源。
   * `duplicate-check` 排在 `:customerId` 之前不只是阅读顺序——它是 `/customers`
   * 下的静态段，写在 `:customerId` 后面会让「查重」这条路径先被参数路由吃掉
   * （Hono 按注册顺序匹配，静态段的优先级是它自己算的，但把静态段写在前是不需要
   * 依赖那个规则的写法）。
   */
  listOpsCustomers: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/customers',
    request: opsCustomerListQuerySchema,
    response: opsCustomerListResponseSchema,
  }),
  createOpsCustomer: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/customers',
    request: opsCustomerCreateRequestSchema,
    response: opsCustomerCreateResponseSchema,
  }),
  checkOpsCustomerDuplicates: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/customers/duplicate-check',
    request: opsCustomerDuplicateCheckRequestSchema,
    response: opsCustomerDuplicateCheckResponseSchema,
  }),
  getOpsCustomer: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/customers/:customerId',
    response: opsCustomerDetailResponseSchema,
  }),
  updateOpsCustomer: defineRoute({
    method: 'PATCH',
    path: '/api/v1/ops/customers/:customerId',
    request: opsCustomerUpdateRequestSchema,
    response: opsCustomerUpdateResponseSchema,
  }),
  transitionOpsCustomer: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/customers/:customerId/transition',
    request: opsCustomerTransitionRequestSchema,
    response: opsCustomerTransitionResponseSchema,
  }),
  getOpsCustomerOverview: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/customers/:customerId/overview',
    response: opsCustomerOverviewResponseSchema,
  }),
  listOpsCustomerContacts: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/customers/:customerId/contacts',
    response: opsCustomerContactListResponseSchema,
  }),
  createOpsCustomerContact: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/customers/:customerId/contacts',
    request: opsCustomerContactCreateRequestSchema,
    response: opsCustomerContactResponseSchema,
  }),
  updateOpsCustomerContact: defineRoute({
    method: 'PATCH',
    path: '/api/v1/ops/customers/:customerId/contacts/:contactId',
    request: opsCustomerContactUpdateRequestSchema,
    response: opsCustomerContactResponseSchema,
  }),
  deleteOpsCustomerContact: defineRoute({
    method: 'DELETE',
    path: '/api/v1/ops/customers/:customerId/contacts/:contactId',
    response: opsCustomerContactDeleteResponseSchema,
  }),
  /**
   * 产品目录（契约 §3.2 / §5.3，十三个端点）。
   *
   * 顺序照契约表：产品 → 套餐 → 套餐的子资源（价格版本、迁移）→ 功能键。
   * 三个列表**不带分页参数**：本轮 RPC 签名里没有 `p_page`/`p_page_size`，
   * 在这里加 `page`/`pageSize` 会得到「前端传了、后端忽略」的分页器——
   * 显示「共 1 页」而实际有 40 条，比没有分页更糟。
   */
  listOpsProducts: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/products',
    request: opsProductListQuerySchema,
    response: opsProductListResponseSchema,
  }),
  createOpsProduct: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/products',
    request: opsProductCreateRequestSchema,
    response: opsProductResponseSchema,
  }),
  updateOpsProduct: defineRoute({
    method: 'PATCH',
    path: '/api/v1/ops/products/:productId',
    request: opsProductUpdateRequestSchema,
    response: opsProductResponseSchema,
  }),
  listOpsPackages: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/packages',
    request: opsPackageListQuerySchema,
    response: opsPackageListResponseSchema,
  }),
  createOpsPackage: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/packages',
    request: opsPackageCreateRequestSchema,
    response: opsPackageCreateResponseSchema,
  }),
  getOpsPackage: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/packages/:packageId',
    response: opsPackageDetailResponseSchema,
  }),
  updateOpsPackage: defineRoute({
    method: 'PATCH',
    path: '/api/v1/ops/packages/:packageId',
    request: opsPackageUpdateRequestSchema,
    response: opsPackageUpdateResponseSchema,
  }),
  listOpsPackagePriceVersions: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/packages/:packageId/price-versions',
    response: opsPriceVersionListResponseSchema,
  }),
  createOpsPackagePriceVersion: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/packages/:packageId/price-versions',
    request: opsPackagePriceVersionCreateRequestSchema,
    response: opsPackagePriceVersionCreateResponseSchema,
  }),
  transitionOpsPackage: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/packages/:packageId/transition',
    request: opsPackageTransitionRequestSchema,
    response: opsPackageTransitionResponseSchema,
  }),
  listOpsFeatures: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/features',
    request: opsFeatureListQuerySchema,
    response: opsFeatureListResponseSchema,
  }),
  createOpsFeature: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/features',
    request: opsFeatureCreateRequestSchema,
    response: opsFeatureResponseSchema,
  }),
  /** `featureKey` 是路径参数而不是 body 字段：它是业务主键，改它等于换一个功能键。 */
  updateOpsFeature: defineRoute({
    method: 'PATCH',
    path: '/api/v1/ops/features/:featureKey',
    request: opsFeatureUpdateRequestSchema,
    response: opsFeatureResponseSchema,
  }),
  /**
   * 合同（契约 §3.3 / §5.4，**十四个**端点）。
   *
   * 顺序照契约表：集合 → 单条 → 单条上的动作与子资源，最后才是挂在
   * `/contract-attachments/` 下的两条。最后两条的前缀**不是** `/contracts/{id}/`
   * ——写错就是 404，而类型系统对路径字符串里的段名没有任何约束，只有
   * `route-parity.test.ts` 能发现「清单里写了、路由没挂」，发现不了「挂到了错的
   * 前缀上但恰好能匹配」。所以这两条单独成组、带注释，方便下一轮核对。
   *
   * 列表带 `page`/`pageSize`（RPC 签名有 `p_page`/`p_page_size`），但**没有**
   * `sort`/`order`：签名里没有这两个参数，在契约里加上它们会得到一个「传了但被
   * 忽略」的排序器。
   */
  listOpsContracts: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/contracts',
    request: opsContractListQuerySchema,
    response: opsContractListResponseSchema,
  }),
  createOpsContract: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/contracts',
    request: opsContractCreateRequestSchema,
    response: opsContractCreateResponseSchema,
  }),
  getOpsContract: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/contracts/:contractId',
    response: opsContractDetailResponseSchema,
  }),
  updateOpsContract: defineRoute({
    method: 'PATCH',
    path: '/api/v1/ops/contracts/:contractId',
    request: opsContractUpdateRequestSchema,
    response: opsContractUpdateResponseSchema,
  }),
  transitionOpsContract: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/contracts/:contractId/transition',
    request: opsContractTransitionRequestSchema,
    response: opsContractTransitionResponseSchema,
  }),
  listOpsContractVersions: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/contracts/:contractId/versions',
    response: opsContractVersionListResponseSchema,
  }),
  createOpsContractAmendment: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/contracts/:contractId/amendments',
    request: opsContractAmendmentCreateRequestSchema,
    response: opsContractAmendmentCreateResponseSchema,
  }),
  transitionOpsContractAmendment: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/contracts/:contractId/amendments/:amendmentId/transition',
    request: opsContractAmendmentTransitionRequestSchema,
    response: opsContractAmendmentTransitionResponseSchema,
  }),
  createOpsContractRenewal: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/contracts/:contractId/renewals',
    request: opsContractRenewalRequestSchema,
    response: opsContractRenewalResponseSchema,
  }),
  getOpsContractEntitlementPreview: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/contracts/:contractId/entitlement-preview',
    response: opsContractEntitlementPreviewResponseSchema,
  }),
  listOpsContractAttachments: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/contracts/:contractId/attachments',
    response: opsContractAttachmentListResponseSchema,
  }),
  createOpsContractAttachment: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/contracts/:contractId/attachments',
    request: opsContractAttachmentCreateRequestSchema,
    response: opsContractAttachmentCreateResponseSchema,
  }),
  /** 附件前缀独立：`/contract-attachments/{id}/...`，不属于任何一份合同路径。 */
  completeOpsContractAttachment: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/contract-attachments/:attachmentId/complete',
    request: opsContractAttachmentCompleteRequestSchema,
    response: opsContractAttachmentCompleteResponseSchema,
  }),
  accessOpsContractAttachment: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/contract-attachments/:attachmentId/access',
    response: opsContractAttachmentAccessResponseSchema,
  }),

  // ── billing 域：应收计划与展期（契约 §5.5 前四条）─────────────────────────
  //
  // 四条路径两种前缀：前三条挂在 `/receivables`，展期是
  // `/receivables/{id}/extensions`。第 4 条不是 `/receivables/{id}/extend`——
  // 契约把它写成「追加一条展期记录」，路径也就照资源命名，而不是照动作命名。
  listOpsReceivables: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/receivables',
    request: opsReceivableListQuerySchema,
    response: opsReceivableListResponseSchema,
  }),
  createOpsReceivablePlan: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/receivables',
    request: opsReceivablePlanCreateRequestSchema,
    response: opsReceivablePlanCreateResponseSchema,
  }),
  getOpsReceivable: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/receivables/:receivableId',
    response: opsReceivableDetailResponseSchema,
  }),
  createOpsReceivableExtension: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/receivables/:receivableId/extensions',
    request: opsReceivableExtensionCreateRequestSchema,
    response: opsReceivableExtensionCreateResponseSchema,
  }),
  listOpsTickets: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/tickets',
    request: opsTicketListQuerySchema,
    response: opsTicketListResponseSchema,
  }),
  /**
   * 静态路径必须排在 `/tickets/:ticketId` 之前。
   *
   * 契约 §5.6 的脚注专门点了这一条：Hono 按注册顺序匹配，若 `:ticketId` 先注册，
   * `assignable-operators` 会被当成一个 ticketId，而它不是 uuid——用户看到的是
   * 「工单不存在」，不是「路由写错了」。
   */
  listOpsTicketAssignableOperators: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/tickets/assignable-operators',
    response: opsTicketAssignableOperatorsResponseSchema,
  }),
  createOpsTicket: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/tickets',
    request: opsTicketCreateRequestSchema,
    response: opsTicketResponseSchema,
  }),
  getOpsTicket: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/tickets/:ticketId',
    response: opsTicketDetailResponseSchema,
  }),
  updateOpsTicket: defineRoute({
    method: 'PATCH',
    path: '/api/v1/ops/tickets/:ticketId',
    request: opsTicketUpdateRequestSchema,
    response: opsTicketResponseSchema,
  }),
  assignOpsTicket: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/tickets/:ticketId/assign',
    request: opsTicketAssignRequestSchema,
    response: opsTicketWriteResponseSchema,
  }),
  transitionOpsTicket: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/tickets/:ticketId/transition',
    request: opsTicketTransitionRequestSchema,
    response: opsTicketWriteResponseSchema,
  }),
  listOpsTicketTimeline: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/tickets/:ticketId/timeline',
    response: opsTicketTimelineResponseSchema,
  }),
  createOpsTicketEvent: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/tickets/:ticketId/events',
    request: opsTicketEventCreateRequestSchema,
    response: opsTicketEventCreateResponseSchema,
  }),
  createOpsTicketReference: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/tickets/:ticketId/references',
    request: opsTicketReferenceCreateRequestSchema,
    response: opsTicketReferenceCreateResponseSchema,
  }),
  // ── billing 下半：收款 / 核销 / 退款（契约 §5.5）─────────────────────────
  //
  // 十条路由的路径形状刻意与契约逐字一致：`receipts/{id}/allocations` 是核销
  // （子资源），`receipt-allocations/{id}/reverse` 是撤销核销（独立资源）——
  // 后者不挂在收款下面，因为一条分配一旦存在，撤销它的人手里只有分配 id。
  listOpsReceipts: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/receipts',
    response: opsReceiptListResponseSchema,
  }),
  createOpsReceipt: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/receipts',
    request: opsReceiptCreateRequestSchema,
    response: opsReceiptCreateResponseSchema,
  }),
  getOpsReceipt: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/receipts/:receiptId',
    response: opsReceiptDetailResponseSchema,
  }),
  transitionOpsReceipt: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/receipts/:receiptId/transition',
    request: opsReceiptTransitionRequestSchema,
    response: opsReceiptTransitionResponseSchema,
  }),
  createOpsReceiptAllocation: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/receipts/:receiptId/allocations',
    request: opsReceiptAllocationCreateRequestSchema,
    response: opsReceiptAllocationCreateResponseSchema,
  }),
  reverseOpsReceipt: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/receipts/:receiptId/reverse',
    request: opsReceiptReverseRequestSchema,
    response: opsReceiptReverseResponseSchema,
  }),
  reverseOpsReceiptAllocation: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/receipt-allocations/:allocationId/reverse',
    request: opsReceiptAllocationReverseRequestSchema,
    response: opsReceiptAllocationReverseResponseSchema,
  }),
  listOpsRefunds: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/refunds',
    response: opsRefundListResponseSchema,
  }),
  createOpsRefund: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/refunds',
    request: opsRefundCreateRequestSchema,
    response: opsRefundCreateResponseSchema,
  }),
  transitionOpsRefund: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/refunds/:refundId/transition',
    request: opsRefundTransitionRequestSchema,
    response: opsRefundTransitionResponseSchema,
  }),
  listOpsSubscriptions: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/subscriptions',
    request: opsSubscriptionListQuerySchema,
    response: opsSubscriptionListResponseSchema,
  }),
  createOpsSubscription: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/subscriptions',
    request: opsSubscriptionCreateRequestSchema,
    response: opsSubscriptionCreateResponseSchema,
  }),
  getOpsSubscription: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/subscriptions/:subscriptionId',
    response: opsSubscriptionDetailResponseSchema,
  }),
  createOpsSubscriptionChangeRequest: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/subscriptions/:subscriptionId/change-requests',
    request: opsChangeRequestCreateRequestSchema,
    response: opsChangeRequestCreateResponseSchema,
  }),
  transitionOpsSubscription: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/subscriptions/:subscriptionId/transition',
    request: opsSubjectTransitionRequestSchema,
    response: opsSubscriptionTransitionResponseSchema,
  }),
  listOpsLicenses: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/licenses',
    request: opsLicenseListQuerySchema,
    response: opsLicenseListResponseSchema,
  }),
  createOpsLicense: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/licenses',
    request: opsLicenseCreateRequestSchema,
    response: opsLicenseCreateResponseSchema,
  }),
  getOpsLicense: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/licenses/:licenseId',
    response: opsLicenseDetailResponseSchema,
  }),
  createOpsLicenseChangeRequest: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/licenses/:licenseId/change-requests',
    request: opsChangeRequestCreateRequestSchema,
    response: opsChangeRequestCreateResponseSchema,
  }),
  transitionOpsLicense: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/licenses/:licenseId/transition',
    request: opsSubjectTransitionRequestSchema,
    response: opsLicenseTransitionResponseSchema,
  }),
  listOpsChangeRequests: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/entitlement-change-requests',
    request: opsChangeRequestListQuerySchema,
    response: opsChangeRequestListResponseSchema,
  }),
  getOpsChangeRequest: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/entitlement-change-requests/:changeRequestId',
    response: opsChangeRequestDetailResponseSchema,
  }),
  transitionOpsChangeRequest: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/entitlement-change-requests/:changeRequestId/transition',
    request: opsChangeRequestTransitionRequestSchema,
    response: opsChangeRequestTransitionResponseSchema,
  }),
  listOpsEntitlementSnapshots: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/entitlement-snapshots',
    request: opsSnapshotListQuerySchema,
    response: opsSnapshotListResponseSchema,
  }),
  getOpsEntitlementSnapshot: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/entitlement-snapshots/:snapshotId',
    response: opsSnapshotDetailResponseSchema,
  }),
  listOpsTenantMappings: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/tenant-mappings',
    request: opsTenantMappingListQuerySchema,
    response: opsTenantMappingListResponseSchema,
  }),
  createOpsTenantMapping: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/tenant-mappings',
    request: opsTenantMappingCreateRequestSchema,
    response: opsTenantMappingCreateResponseSchema,
  }),
  getOpsTenantMapping: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/tenant-mappings/:mappingId',
    response: opsTenantMappingDetailResponseSchema,
  }),
  updateOpsTenantMapping: defineRoute({
    method: 'PATCH',
    path: '/api/v1/ops/tenant-mappings/:mappingId',
    request: opsTenantMappingUpdateRequestSchema,
    response: opsTenantMappingUpdateResponseSchema,
  }),
  createOpsTenantCommand: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/tenant-mappings/:mappingId/commands',
    request: opsTenantCommandCreateRequestSchema,
    response: opsTenantCommandCreateResponseSchema,
  }),
  listOpsTenantCommands: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/tenant-commands',
    request: opsTenantCommandListQuerySchema,
    response: opsTenantCommandListResponseSchema,
  }),
  getOpsTenantCommand: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/tenant-commands/:commandId',
    response: opsTenantCommandDetailResponseSchema,
  }),
  listOpsTenantCommandAttempts: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/tenant-commands/:commandId/attempts',
    response: opsTenantCommandAttemptListResponseSchema,
  }),
  retryOpsTenantCommand: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/tenant-commands/:commandId/retry',
    request: opsTenantCommandTransitionRequestSchema,
    response: opsTenantCommandTransitionResponseSchema,
  }),
  cancelOpsTenantCommand: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/tenant-commands/:commandId/cancel',
    request: opsTenantCommandTransitionRequestSchema,
    response: opsTenantCommandTransitionResponseSchema,
  }),
  listOpsDeployments: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/deployments',
    request: opsDeploymentListQuerySchema,
    response: opsDeploymentListResponseSchema,
  }),
  createOpsDeployment: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/deployments',
    request: opsDeploymentCreateRequestSchema,
    response: opsDeploymentCreateResponseSchema,
  }),
  getOpsDeployment: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/deployments/:deploymentId',
    response: opsDeploymentDetailResponseSchema,
  }),
  updateOpsDeployment: defineRoute({
    method: 'PATCH',
    path: '/api/v1/ops/deployments/:deploymentId',
    request: opsDeploymentUpdateRequestSchema,
    response: opsDeploymentUpdateResponseSchema,
  }),
  transitionOpsDeployment: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/deployments/:deploymentId/transition',
    request: opsDeploymentTransitionRequestSchema,
    response: opsDeploymentTransitionResponseSchema,
  }),
  createOpsDeploymentVersionRecord: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/deployments/:deploymentId/version-records',
    request: opsDeploymentVersionRecordCreateRequestSchema,
    response: opsDeploymentVersionRecordCreateResponseSchema,
  }),
  listOpsDeploymentVersionRecords: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/deployments/:deploymentId/version-records',
    request: opsDeploymentVersionRecordListQuerySchema,
    response: opsDeploymentVersionRecordListResponseSchema,
  }),
  getOpsOverview: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/overview',
    request: opsOverviewQuerySchema,
    response: opsOverviewResponseSchema,
  }),
  getOpsReceivableReport: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/reports/receivables',
    request: opsReceivableReportQuerySchema,
    response: opsReceivableReportResponseSchema,
  }),
  getOpsExpiringEntitlementReport: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/reports/expiring-entitlements',
    request: opsExpiringEntitlementReportQuerySchema,
    response: opsExpiringEntitlementReportResponseSchema,
  }),
  getOpsTenantSyncFailureReport: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/reports/tenant-sync-failures',
    request: opsTenantSyncFailureReportQuerySchema,
    response: opsTenantSyncFailureReportResponseSchema,
  }),
  getOpsDeploymentVersionReport: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/reports/deployment-versions',
    request: opsDeploymentVersionReportQuerySchema,
    response: opsDeploymentVersionReportResponseSchema,
  }),
  getOpsSettings: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/settings',
    response: opsSettingsResponseSchema,
  }),
  updateOpsSettings: defineRoute({
    method: 'PATCH',
    path: '/api/v1/ops/settings',
    request: opsSettingsUpdateRequestSchema,
    response: opsSettingsResponseSchema,
  }),
  listOpsDictionaries: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/dictionaries',
    request: opsDictionaryListQuerySchema,
    response: opsDictionaryListResponseSchema,
  }),
  createOpsDictionaryItem: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/dictionaries/:code/items',
    request: opsDictionaryItemCreateRequestSchema,
    response: opsDictionaryItemCreateResponseSchema,
  }),
  updateOpsDictionaryItem: defineRoute({
    method: 'PATCH',
    path: '/api/v1/ops/dictionary-items/:itemId',
    request: opsDictionaryItemUpdateRequestSchema,
    response: opsDictionaryItemUpdateResponseSchema,
  }),
  listOpsExports: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/exports',
    request: opsExportListQuerySchema,
    response: opsExportListResponseSchema,
  }),
  createOpsExport: defineRoute({
    method: 'POST',
    path: '/api/v1/ops/exports',
    request: opsExportCreateRequestSchema,
    response: opsExportCreateResponseSchema,
  }),
  getOpsExport: defineRoute({
    method: 'GET',
    path: '/api/v1/ops/exports/:exportId',
    response: opsExportDetailResponseSchema,
  }),
} as const satisfies Record<string, RouteContract>;

export type OpsRouteKey = keyof typeof OPS_ROUTES;

/**
 * 两张清单的并集，供 `respond()` 与对账测试使用。
 *
 * 用展开而不是让调用方自己判断属于哪张表：这样 `respond(context, 'getMeta', ...)`
 * 在 T-01 之后可以直接用，不必改签名。同名键会静默覆盖，所以对账测试里有一条
 * 「同一 key 出现在两张表」的断言——那是展开唯一掩盖不了的东西。
 */
export const ROUTE_ENTRIES = { ...ROUTES, ...OPS_ROUTES };

/** 全部注册表。对账测试遍历它，新增第三张表时只需在这里多一项。 */
export const ROUTE_REGISTRIES = { ROUTES, OPS_ROUTES } as const;

export type RouteKey = keyof typeof ROUTE_ENTRIES;

/**
 * 业务端（`/api/*`）的端点键。
 *
 * 前端 api client 只服务这张表。`RouteKey` 是并集，用它当约束会让租户前端
 * 在类型层就「可以调用」运营端点——而它既没有运营令牌，也不该走那条路径。
 * 类型上允许调不通的接口，最终会以运行期 401 的形式出现在某个页面上。
 */
export type BusinessRouteKey = keyof typeof ROUTES;
export type RoutePath<K extends RouteKey> = (typeof ROUTE_ENTRIES)[K]['path'];
export type RouteMethod<K extends RouteKey> = (typeof ROUTE_ENTRIES)[K]['method'];
export type RouteResponse<K extends RouteKey> = z.output<(typeof ROUTE_ENTRIES)[K]['response']>;
export type RouteRequest<K extends RouteKey> = (typeof ROUTE_ENTRIES)[K] extends {
  request: infer T extends z.ZodType;
}
  ? z.output<T>
  : undefined;

/** 从 `/api/organizations/:id/members/:userId` 抽出 `'id' | 'userId'`。 */
export type PathParamNames<P extends string> = P extends `${string}:${infer Rest}`
  ? Rest extends `${infer Name}/${infer Tail}`
    ? Name | PathParamNames<`/${Tail}`>
    : Rest
  : never;
