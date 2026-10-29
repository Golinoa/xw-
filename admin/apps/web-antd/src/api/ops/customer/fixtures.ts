/**
 * customer 域开发态虚构数据（仅 `VITE_OPS_MOCK=true` 时由 `./mock` 引用）。
 *
 * 约束（`admin/apps/web-antd/src/api/ops/README.md`）：
 * 1. 全部虚构：企业名称统一带「示例」前缀，联系方式使用保留号段与 `example.invalid`；
 * 2. 不是 mock 服务、不代表后端已集成；页面必须显示「开发态数据」提示；
 * 3. 生产构建中该文件随 `./mock` 一起被 tree-shake（调用点是字面量环境判断）。
 */
import type { Customer, CustomerContact } from './index';

/** 虚构运营成员（用于 `owner` 展示；真实值应来自 `GET /operators`）。 */
export const FIXTURE_OPERATORS = [
  { id: 'op-demo-001', displayName: '示例商务甲' },
  { id: 'op-demo-002', displayName: '示例商务乙' },
  { id: 'op-demo-003', displayName: '示例交付丙' },
] as const;

export interface FixtureCustomerRecord {
  customer: Customer;
  contacts: CustomerContact[];
  counts: {
    contracts: number;
    deployments: number;
    licenses: number;
    receivables: number;
    subscriptions: number;
    tickets: number;
  };
}

function contact(
  id: string,
  name: string,
  jobTitle: string,
  phone: string,
  email: string,
  isPrimary: boolean,
  usageScene: string,
): CustomerContact {
  return {
    id,
    name,
    jobTitle,
    // 掩码规则与后端一致：手机保留前 3 后 4，邮箱保留首字母与域名
    phoneMasked: `${phone.slice(0, 3)}****${phone.slice(-4)}`,
    emailMasked: `${email.slice(0, 1)}***@${email.split('@')[1] ?? ''}`,
    phone,
    email,
    isPrimary,
    usageScene,
    version: 1,
  };
}

export const FIXTURE_CUSTOMERS: FixtureCustomerRecord[] = [
  {
    customer: {
      id: 'cus-0001',
      customerNo: 'KH-2026-000001',
      name: '示例旅行社甲',
      unifiedSocialCreditCode: '91310000MA1EXAMPLE1',
      regionCode: '310000',
      status: 'active',
      owner: { ...FIXTURE_OPERATORS[0] },
      sourceNote: '示例来源：行业展会',
      internalNote: '示例内部备注：SaaS 全模块在用',
      version: 3,
      createdAt: '2026-01-12T02:00:00Z',
      updatedAt: '2026-09-18T06:20:00Z',
      archivedAt: null,
      archiveReason: null,
    },
    contacts: [
      contact(
        'ct-0001',
        '示例联系人甲',
        '信息部经理',
        '13800001234',
        'contact.a@example.invalid',
        true,
        '日常对接',
      ),
      contact(
        'ct-0002',
        '示例联系人乙',
        '财务主管',
        '13900005678',
        'contact.b@example.invalid',
        false,
        '账款对账',
      ),
    ],
    counts: {
      contracts: 2,
      receivables: 8,
      subscriptions: 2,
      licenses: 0,
      deployments: 0,
      tickets: 3,
    },
  },
  {
    customer: {
      id: 'cus-0002',
      customerNo: 'KH-2026-000002',
      name: '示例旅行社乙（私有化）',
      unifiedSocialCreditCode: null,
      regionCode: '440300',
      status: 'onboarding',
      owner: { ...FIXTURE_OPERATORS[1] },
      sourceNote: '示例来源：老客户转介绍',
      internalNote: '示例内部备注：私有化交付中',
      version: 1,
      createdAt: '2026-05-06T03:10:00Z',
      updatedAt: '2026-09-02T01:05:00Z',
      archivedAt: null,
      archiveReason: null,
    },
    contacts: [
      contact(
        'ct-0003',
        '示例联系人丙',
        '项目经理',
        '13700002222',
        'contact.c@example.invalid',
        true,
        '实施交付',
      ),
    ],
    counts: {
      contracts: 1,
      receivables: 3,
      subscriptions: 0,
      licenses: 1,
      deployments: 1,
      tickets: 1,
    },
  },
  {
    customer: {
      id: 'cus-0003',
      customerNo: 'KH-2026-000003',
      name: '示例文旅集团丙',
      unifiedSocialCreditCode: null,
      regionCode: '110000',
      status: 'signed',
      owner: { ...FIXTURE_OPERATORS[0] },
      sourceNote: '示例来源：渠道合作',
      internalNote: null,
      version: 1,
      createdAt: '2026-09-21T07:45:00Z',
      updatedAt: '2026-09-21T07:45:00Z',
      archivedAt: null,
      archiveReason: null,
    },
    contacts: [
      contact(
        'ct-0004',
        '示例联系人丁',
        '采购负责人',
        '13600003333',
        'contact.d@example.invalid',
        true,
        '合同签署',
      ),
    ],
    counts: {
      contracts: 1,
      receivables: 0,
      subscriptions: 0,
      licenses: 0,
      deployments: 0,
      tickets: 0,
    },
  },
  {
    customer: {
      id: 'cus-0004',
      customerNo: 'KH-2026-000004',
      name: '示例旅行社丁',
      unifiedSocialCreditCode: null,
      regionCode: '330100',
      status: 'suspended',
      owner: { ...FIXTURE_OPERATORS[2] },
      sourceNote: '示例来源：官网咨询',
      internalNote: '示例内部备注：因欠款暂停服务',
      version: 4,
      createdAt: '2025-11-03T05:00:00Z',
      updatedAt: '2026-08-11T09:30:00Z',
      archivedAt: null,
      archiveReason: null,
    },
    contacts: [
      contact(
        'ct-0005',
        '示例联系人戊',
        '总经理',
        '13500004444',
        'contact.e@example.invalid',
        true,
        '商务决策',
      ),
    ],
    counts: {
      contracts: 1,
      receivables: 4,
      subscriptions: 1,
      licenses: 0,
      deployments: 0,
      tickets: 2,
    },
  },
  {
    customer: {
      id: 'cus-0005',
      customerNo: 'KH-2025-000118',
      name: '示例旅行服务公司戊',
      unifiedSocialCreditCode: null,
      regionCode: '510100',
      status: 'terminated',
      owner: { ...FIXTURE_OPERATORS[1] },
      sourceNote: '示例来源：历史客户',
      internalNote: '示例内部备注：合约到期不再续约',
      version: 6,
      createdAt: '2025-03-14T02:20:00Z',
      updatedAt: '2026-03-02T08:00:00Z',
      archivedAt: '2026-03-02T08:00:00Z',
      archiveReason: '示例：合同到期且客户不再续约',
    },
    contacts: [
      contact(
        'ct-0006',
        '示例联系人己',
        '行政',
        '13400005555',
        'contact.f@example.invalid',
        true,
        '历史对接',
      ),
    ],
    counts: {
      contracts: 1,
      receivables: 0,
      subscriptions: 0,
      licenses: 0,
      deployments: 0,
      tickets: 0,
    },
  },
  {
    customer: {
      id: 'cus-0006',
      customerNo: 'KH-2026-000006',
      name: '示例国际旅行社己',
      unifiedSocialCreditCode: null,
      regionCode: '320100',
      status: 'active',
      owner: { ...FIXTURE_OPERATORS[0] },
      sourceNote: '示例来源：合作伙伴推荐',
      internalNote: null,
      version: 2,
      createdAt: '2026-02-27T01:15:00Z',
      updatedAt: '2026-07-19T03:40:00Z',
      archivedAt: null,
      archiveReason: null,
    },
    contacts: [
      contact(
        'ct-0007',
        '示例联系人庚',
        '运营总监',
        '13300006666',
        'contact.g@example.invalid',
        true,
        '日常对接',
      ),
    ],
    counts: {
      contracts: 1,
      receivables: 6,
      subscriptions: 1,
      licenses: 0,
      deployments: 0,
      tickets: 1,
    },
  },
  {
    customer: {
      id: 'cus-0007',
      customerNo: 'KH-2026-000007',
      name: '示例旅游科技有限公司庚',
      unifiedSocialCreditCode: null,
      regionCode: '350200',
      status: 'active',
      owner: null,
      sourceNote: null,
      internalNote: '示例内部备注：待分配负责人',
      version: 1,
      createdAt: '2026-08-30T06:05:00Z',
      updatedAt: '2026-08-30T06:05:00Z',
      archivedAt: null,
      archiveReason: null,
    },
    contacts: [],
    counts: {
      contracts: 0,
      receivables: 0,
      subscriptions: 0,
      licenses: 0,
      deployments: 0,
      tickets: 0,
    },
  },
  {
    customer: {
      id: 'cus-0008',
      customerNo: 'KH-2026-000008',
      name: '示例旅行社辛',
      unifiedSocialCreditCode: null,
      regionCode: '420100',
      status: 'onboarding',
      owner: { ...FIXTURE_OPERATORS[2] },
      sourceNote: '示例来源：线上留资',
      internalNote: null,
      version: 1,
      createdAt: '2026-10-08T02:35:00Z',
      updatedAt: '2026-10-20T05:10:00Z',
      archivedAt: null,
      archiveReason: null,
    },
    contacts: [
      contact(
        'ct-0008',
        '示例联系人辛',
        '产品经理',
        '13200007777',
        'contact.h@example.invalid',
        true,
        '需求确认',
      ),
    ],
    counts: {
      contracts: 0,
      receivables: 0,
      subscriptions: 0,
      licenses: 0,
      deployments: 0,
      tickets: 1,
    },
  },
];
