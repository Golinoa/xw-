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
  customerTagListResponseSchema,
  customerTagResponseSchema,
  updateCustomerRequestSchema,
} from './customers';
import type { HttpMethod } from './http';
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

export type RouteKey = keyof typeof ROUTES;
export type RoutePath<K extends RouteKey> = (typeof ROUTES)[K]['path'];
export type RouteMethod<K extends RouteKey> = (typeof ROUTES)[K]['method'];
export type RouteResponse<K extends RouteKey> = z.output<(typeof ROUTES)[K]['response']>;
export type RouteRequest<K extends RouteKey> = (typeof ROUTES)[K] extends {
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
