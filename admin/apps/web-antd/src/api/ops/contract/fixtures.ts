/**
 * contract 域开发态虚构数据（仅 `VITE_OPS_MOCK=true` 时由 `./mock` 引用）。
 *
 * 全部虚构：合同号为演示序号，客户名带「示例」前缀，金额仅为演示值。
 * 生产构建随 `./mock` 一起被 tree-shake。
 */
import type {
  ContractAttachment,
  ContractEntity,
  ContractItem,
  ContractReceivableRow,
} from './index';

export interface FixtureContractRecord {
  contract: ContractEntity;
  items: ContractItem[];
  receivables: ContractReceivableRow[];
  attachments: ContractAttachment[];
}

function contract(
  value: Partial<ContractEntity> &
    Pick<ContractEntity, 'contractNo' | 'id' | 'status'>,
): ContractEntity {
  return {
    businessNote: null,
    createdAt: '2026-01-05T02:00:00Z',
    currency: 'CNY',
    customer: { id: 'cus-0001', name: '示例旅行社甲' },
    effectiveOn: null,
    expiresOn: null,
    paymentTerms: '示例：签约后 15 日内支付 50%，上线后 30 日内结清',
    renewedFromContractId: null,
    salesMode: 'saas',
    salesOwner: { displayName: '示例商务甲', id: 'op-demo-001' },
    signedOn: null,
    statusReason: null,
    taxNote: '示例：含税价，税率按合同约定留档',
    totalAmount: 0,
    updatedAt: '2026-01-05T02:00:00Z',
    version: 1,
    currentVersionNo: 1,
    ...value,
  };
}

export const FIXTURE_CONTRACTS: FixtureContractRecord[] = [
  {
    attachments: [
      {
        byteSize: 248_320,
        contentType: 'application/pdf',
        fileName: '示例合同扫描件.pdf',
        id: 'att-0001',
        status: 'stored',
        uploadedAt: '2026-02-11T03:20:00Z',
        uploadedBy: '示例商务甲',
      },
      {
        byteSize: 65_536,
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileName: '示例付款条款附件.docx',
        id: 'att-0002',
        status: 'stored',
        uploadedAt: '2026-02-11T03:22:00Z',
        uploadedBy: '示例商务甲',
      },
    ],
    contract: contract({
      businessNote: '示例：三年期合作，含两次现场培训',
      contractNo: 'HT-2026-000045',
      createdAt: '2026-02-01T01:10:00Z',
      currentVersionNo: 2,
      customer: { id: 'cus-0001', name: '示例旅行社甲' },
      effectiveOn: '2026-03-01',
      expiresOn: '2027-02-28',
      id: 'con-0001',
      signedOn: '2026-02-10',
      status: 'active',
      totalAmount: 396_000,
      updatedAt: '2026-03-01T00:30:00Z',
      version: 5,
    }),
    items: [
      {
        amount: 268_000,
        billingType: 'periodic',
        id: 'cit-0001',
        itemNameSnapshot: '专业版（示例）',
        packageId: 'pkg-0002',
        packagePriceVersionId: 'pv-0002-1',
        productId: 'prd-0001',
        quantity: 1,
        salesMode: 'saas',
        termMonths: 12,
        unitPrice: 268_000,
      },
      {
        amount: 128_000,
        billingType: 'one_time',
        id: 'cit-0002',
        itemNameSnapshot: '实施服务包（示例）',
        packageId: 'pkg-0004',
        packagePriceVersionId: 'pv-0004-1',
        productId: 'prd-0001',
        quantity: 1,
        salesMode: 'saas',
        termMonths: null,
        unitPrice: 128_000,
      },
    ],
    receivables: [
      {
        amount: 198_000,
        currency: 'CNY',
        dueDate: '2026-03-15',
        id: 'rec-0001',
        outstanding: 0,
        periodNo: 1,
        status: 'paid',
      },
      {
        amount: 198_000,
        currency: 'CNY',
        dueDate: '2026-09-15',
        id: 'rec-0002',
        outstanding: 198_000,
        periodNo: 2,
        status: 'upcoming',
      },
    ],
  },
  {
    attachments: [],
    contract: contract({
      contractNo: 'HT-2026-000061',
      createdAt: '2026-10-12T06:40:00Z',
      customer: { id: 'cus-0003', name: '示例文旅集团丙' },
      id: 'con-0002',
      paymentTerms: '示例：一次性付款',
      status: 'draft',
      totalAmount: 128_000,
      updatedAt: '2026-10-22T02:15:00Z',
      version: 2,
    }),
    items: [
      {
        amount: 128_000,
        billingType: 'periodic',
        id: 'cit-0003',
        itemNameSnapshot: '标准版（示例）',
        packageId: 'pkg-0001',
        packagePriceVersionId: 'pv-0001-2',
        productId: 'prd-0001',
        quantity: 1,
        salesMode: 'saas',
        termMonths: 12,
        unitPrice: 128_000,
      },
    ],
    receivables: [],
  },
  {
    attachments: [
      {
        byteSize: 1_048_576,
        contentType: 'application/pdf',
        fileName: '示例私有化授权协议.pdf',
        id: 'att-0003',
        status: 'stored',
        uploadedAt: '2026-10-05T08:00:00Z',
        uploadedBy: '示例交付丙',
      },
    ],
    contract: contract({
      contractNo: 'HT-2026-000058',
      createdAt: '2026-09-28T03:00:00Z',
      customer: { id: 'cus-0002', name: '示例旅行社乙（私有化）' },
      id: 'con-0003',
      salesMode: 'private',
      salesOwner: { displayName: '示例商务乙', id: 'op-demo-002' },
      status: 'reviewing',
      totalAmount: 480_000,
      updatedAt: '2026-10-06T01:20:00Z',
      version: 3,
    }),
    items: [
      {
        amount: 480_000,
        billingType: 'fixed_term',
        id: 'cit-0004',
        itemNameSnapshot: '私有化标准授权（示例）',
        packageId: 'pkg-0003',
        packagePriceVersionId: 'pv-0003-1',
        productId: 'prd-0002',
        quantity: 1,
        salesMode: 'private',
        termMonths: 12,
        unitPrice: 480_000,
      },
    ],
    receivables: [],
  },
  {
    attachments: [],
    contract: contract({
      contractNo: 'HT-2025-000204',
      createdAt: '2025-06-02T01:00:00Z',
      customer: { id: 'cus-0004', name: '示例旅行社丁' },
      effectiveOn: '2025-07-01',
      expiresOn: '2026-06-30',
      id: 'con-0004',
      signedOn: '2025-06-20',
      status: 'expired',
      totalAmount: 128_000,
      updatedAt: '2026-07-01T00:05:00Z',
      version: 7,
    }),
    items: [
      {
        amount: 128_000,
        billingType: 'periodic',
        id: 'cit-0005',
        itemNameSnapshot: '标准版（示例）',
        packageId: 'pkg-0001',
        packagePriceVersionId: 'pv-0001-1',
        productId: 'prd-0001',
        quantity: 1,
        salesMode: 'saas',
        termMonths: 12,
        unitPrice: 128_000,
      },
    ],
    receivables: [],
  },
];
