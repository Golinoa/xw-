import type { CustomerIdType, CustomerTag, SortOrder } from '@erp/contracts';
import type { ApiEnvironment } from '../../middleware/auth';
import { RestConflictError, createRestClient } from '../../lib/rest-client';
import { sanitizeKeyword } from '../../lib/postgrest';

/**
 * 客户域服务与仓储（R-CUSTOMER-01）。
 *
 * 分层与既有 `organization-service` 一致：
 * - 仓储只做 PostgREST 读写与 snake_case → camelCase 映射，不判断业务；
 * - 服务规则（查重、掩码、标签校验）以纯函数或仓储方法暴露，不依赖 HTTP；
 * - 路由层负责把领域结果/错误映射成 HTTP 状态与共享错误码。
 *
 * 列表一次请求内会发多次查询（客户分页、标签关联、标签、来源），而不是让 PostgREST
 * 做嵌套嵌入：本域外键是 `(source_id, organization_id)` 复合外键，PostgREST 的
 * 关系推断不稳定；显式的 `in.(...)` 批量查询结果可预期，也不会产生 N+1。
 */

const LIST_COLUMNS = 'id,name,phone,email,source_id,created_at,updated_at';
const DETAIL_COLUMNS =
  'id,name,phone,email,id_type,id_number,birthday,source_id,remark,version,created_by,created_at,updated_at';

const SORT_COLUMNS: Record<string, string> = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  name: 'name',
};

type CustomerRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  id_type: CustomerIdType | null;
  id_number: string | null;
  birthday: string | null;
  source_id: string | null;
  remark: string | null;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type TagRow = { id: string; name: string; color: string | null };
type SourceRow = { id: string; name: string };

export interface CustomerRecord {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  idType?: CustomerIdType;
  idNumber?: string;
  birthday?: string;
  sourceId?: string;
  sourceName?: string;
  tags: CustomerTag[];
  remark?: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerListFilter {
  organizationId: string;
  keyword?: string;
  sourceId?: string;
  tagId?: string;
  page: number;
  pageSize: number;
  sort: string;
  order: SortOrder;
  /** 数据范围为 own 的角色（计调员）只能看到自己创建的客户。 */
  ownerUserId?: string;
}

/** 创建时空值统一落库为 NULL，`null` 与缺失等价（契约层两种情况都允许）。 */
export interface CustomerCreateInput {
  organizationId: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  idType?: CustomerIdType | null;
  idNumber?: string | null;
  birthday?: string | null;
  sourceId?: string | null;
  tagIds?: string[];
  remark?: string | null;
}

/**
 * 更新语义：`undefined` 表示不修改，`null` 表示清空该字段。
 * 没有这个区分，用户填错的手机号或备注就永远删不掉。
 */
export interface CustomerUpdateInput {
  name?: string;
  phone?: string | null;
  email?: string | null;
  idType?: CustomerIdType | null;
  idNumber?: string | null;
  birthday?: string | null;
  sourceId?: string | null;
  tagIds?: string[];
  remark?: string | null;
}

export interface CustomerRepository {
  list(filter: CustomerListFilter): Promise<{ items: CustomerRecord[]; total: number }>;
  findById(organizationId: string, customerId: string): Promise<CustomerRecord | null>;
  findDuplicatesByPhone(organizationId: string, phone: string): Promise<CustomerRecord[]>;
  create(input: CustomerCreateInput): Promise<CustomerRecord>;
  update(
    organizationId: string,
    customerId: string,
    expectedVersion: number,
    patch: CustomerUpdateInput,
  ): Promise<CustomerRecord | null>;
  softDelete(organizationId: string, customerId: string, actorId: string): Promise<boolean>;
  /** 从回收站恢复；返回 false 表示该 ID 不在回收站里（没删过或不存在）。 */
  restore(organizationId: string, customerId: string): Promise<boolean>;
  assertTagsBelongToOrganization(organizationId: string, tagIds: string[]): Promise<void>;
  listTags(organizationId: string): Promise<CustomerTag[]>;
  createTag(organizationId: string, name: string, color?: string): Promise<CustomerTag>;
}

/** 标签不存在或不属于当前组织，按校验错误处理而不是静默丢弃。 */
export class CustomerTagInvalidError extends Error {
  constructor(readonly tagIds: string[]) {
    super('One or more tags do not belong to this organization');
    this.name = 'CustomerTagInvalidError';
  }
}

export class CustomerTagConflictError extends Error {
  constructor() {
    super('A tag with this name already exists');
    this.name = 'CustomerTagConflictError';
  }
}

/**
 * 客户写入时的唯一约束冲突。
 *
 * 手机号刻意**不唯一**（同号只做重复提示，R-CUSTOMER-01），因此这里不能叫
 * `CustomerPhoneConflictError`——真正会撞的是标签关联主键这类约束，笼统按冲突处理。
 */
export class CustomerConflictError extends Error {
  constructor() {
    super('The customer conflicts with an existing record');
    this.name = 'CustomerConflictError';
  }
}

/* ------------------------------------------------------------------ 掩码 */

/** 只保留前 3 位与后 4 位；不足 7 位时整体打码，避免拼出原值。 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 0) return '';
  if (digits.length < 7) return '*'.repeat(digits.length);
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

export function maskEmail(email: string): string {
  const atIndex = email.indexOf('@');
  if (atIndex <= 0) return '***';
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***${domain}`;
}

/** 证件号只露首尾各 2 位，中间按长度打码。 */
export function maskIdNumber(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}${'*'.repeat(Math.max(value.length - 4, 2))}${value.slice(-2)}`;
}

/**
 * 关键字清洗见 `lib/postgrest`。这里保留同名导出，是因为本模块的单元测试
 * 直接引用它；实现只有一份，行为不会分叉。
 */
export { sanitizeKeyword } from '../../lib/postgrest';

/* -------------------------------------------------------------- 行映射 */

function optional(value: string | null): string | undefined {
  return value === null || value === '' ? undefined : value;
}

function toRecord(row: CustomerRow, tags: CustomerTag[], sourceName?: string): CustomerRecord {
  return {
    id: row.id,
    name: row.name,
    phone: optional(row.phone),
    email: optional(row.email),
    idType: row.id_type ?? undefined,
    idNumber: optional(row.id_number),
    birthday: optional(row.birthday),
    sourceId: row.source_id ?? undefined,
    sourceName,
    tags,
    remark: optional(row.remark),
    version: row.version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTag(row: TagRow): CustomerTag {
  return { id: row.id, name: row.name, color: row.color ?? undefined };
}

function inList(values: string[]): string {
  return `in.(${values.map((value) => encodeURIComponent(value)).join(',')})`;
}

/* --------------------------------------------------------------- 仓储 */

export function createSupabaseCustomerRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): CustomerRepository {
  const client = createRestClient(environment, token);

  async function loadTags(
    organizationId: string,
    customerIds: string[],
  ): Promise<Map<string, CustomerTag[]>> {
    const result = new Map<string, CustomerTag[]>();
    if (customerIds.length === 0) return result;

    const links = await client.rest<Array<{ customer_id: string; tag_id: string }>>(
      `customer_tag_links?organization_id=eq.${encodeURIComponent(organizationId)}&customer_id=${inList(customerIds)}&select=customer_id,tag_id`,
      { organizationId },
    );
    if (links.length === 0) return result;

    const tagIds = [...new Set(links.map((link) => link.tag_id))];
    const tags = await client.rest<TagRow[]>(
      `customer_tags?organization_id=eq.${encodeURIComponent(organizationId)}&id=${inList(tagIds)}&select=id,name,color`,
      { organizationId },
    );
    const byId = new Map(tags.map((tag) => [tag.id, toTag(tag)]));

    for (const link of links) {
      const tag = byId.get(link.tag_id);
      if (!tag) continue;
      const bucket = result.get(link.customer_id) ?? [];
      bucket.push(tag);
      result.set(link.customer_id, bucket);
    }
    return result;
  }

  async function loadSourceNames(
    organizationId: string,
    rows: CustomerRow[],
  ): Promise<Map<string, string>> {
    const sourceIds = [
      ...new Set(rows.map((row) => row.source_id).filter((id): id is string => !!id)),
    ];
    if (sourceIds.length === 0) return new Map();
    const sources = await client.rest<SourceRow[]>(
      `customer_sources?organization_id=eq.${encodeURIComponent(organizationId)}&id=${inList(sourceIds)}&select=id,name`,
      { organizationId },
    );
    return new Map(sources.map((source) => [source.id, source.name]));
  }

  async function decorate(organizationId: string, rows: CustomerRow[]): Promise<CustomerRecord[]> {
    if (rows.length === 0) return [];
    const [tags, sources] = await Promise.all([
      loadTags(
        organizationId,
        rows.map((row) => row.id),
      ),
      loadSourceNames(organizationId, rows),
    ]);
    return rows.map((row) =>
      toRecord(row, tags.get(row.id) ?? [], row.source_id ? sources.get(row.source_id) : undefined),
    );
  }

  async function replaceTags(
    organizationId: string,
    customerId: string,
    tagIds: string[],
  ): Promise<void> {
    await client.rest<void>(
      `customer_tag_links?organization_id=eq.${encodeURIComponent(organizationId)}&customer_id=eq.${encodeURIComponent(customerId)}`,
      { method: 'DELETE', organizationId },
    );
    if (tagIds.length === 0) return;
    await client.rest<void>('customer_tag_links', {
      method: 'POST',
      organizationId,
      headers: { Prefer: 'return=minimal' },
      body: tagIds.map((tagId) => ({
        customer_id: customerId,
        tag_id: tagId,
        organization_id: organizationId,
      })),
    });
  }

  async function findById(
    organizationId: string,
    customerId: string,
  ): Promise<CustomerRecord | null> {
    const rows = await client.rest<CustomerRow[]>(
      `customers?organization_id=eq.${encodeURIComponent(organizationId)}&id=eq.${encodeURIComponent(customerId)}&deleted_at=is.null&select=${DETAIL_COLUMNS}&limit=1`,
      { organizationId },
    );
    const row = rows[0];
    if (!row) return null;
    const [decorated] = await decorate(organizationId, [row]);
    return decorated ?? null;
  }

  async function list(
    filter: CustomerListFilter,
  ): Promise<{ items: CustomerRecord[]; total: number }> {
    const query = new URLSearchParams();
    query.set('organization_id', `eq.${filter.organizationId}`);
    query.set('deleted_at', 'is.null');
    query.set('select', LIST_COLUMNS);
    query.set('order', `${SORT_COLUMNS[filter.sort] ?? 'created_at'}.${filter.order}`);
    query.set('limit', String(filter.pageSize));
    query.set('offset', String((filter.page - 1) * filter.pageSize));
    if (filter.ownerUserId) query.set('created_by', `eq.${filter.ownerUserId}`);
    if (filter.sourceId) query.set('source_id', `eq.${filter.sourceId}`);

    const keyword = filter.keyword ? sanitizeKeyword(filter.keyword) : '';
    if (keyword) {
      const pattern = `*${keyword}*`;
      query.set('or', `(name.ilike.${pattern},phone.ilike.${pattern},remark.ilike.${pattern})`);
    }

    if (filter.tagId) {
      const links = await client.rest<Array<{ customer_id: string }>>(
        `customer_tag_links?organization_id=eq.${encodeURIComponent(filter.organizationId)}&tag_id=eq.${encodeURIComponent(filter.tagId)}&select=customer_id`,
        { organizationId: filter.organizationId },
      );
      const customerIds = links.map((link) => link.customer_id);
      if (customerIds.length === 0) {
        return { items: [], total: 0 };
      }
      query.set('id', inList(customerIds));
    }

    const page = await client.restPage<CustomerRow>(`customers?${query.toString()}`, {
      organizationId: filter.organizationId,
    });
    return { items: await decorate(filter.organizationId, page.rows), total: page.total };
  }

  async function create(input: CustomerCreateInput): Promise<CustomerRecord> {
    let newId: string | null;
    try {
      newId = await client.rest<string | null>('rpc/create_customer_with_tags', {
        method: 'POST',
        organizationId: input.organizationId,
        body: {
          requested_name: input.name,
          requested_tag_ids: input.tagIds ?? [],
          requested_phone: input.phone ?? null,
          requested_email: input.email ?? null,
          requested_id_type: input.idType ?? null,
          requested_id_number: input.idNumber ?? null,
          requested_birthday: input.birthday ?? null,
          requested_source_id: input.sourceId ?? null,
          requested_remark: input.remark ?? null,
        },
      });
    } catch (cause) {
      if (cause instanceof RestConflictError) throw new CustomerConflictError();
      throw cause;
    }
    if (!newId) throw new Error('Customer creation returned no identifier');
    const created = await findById(input.organizationId, newId);
    if (!created) throw new Error('Created customer could not be read back');
    return created;
  }

  async function update(
    organizationId: string,
    customerId: string,
    expectedVersion: number,
    patch: CustomerUpdateInput,
  ): Promise<CustomerRecord | null> {
    const body: Record<string, unknown> = {
      version: expectedVersion + 1,
      updated_at: new Date().toISOString(),
    };
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.phone !== undefined) body.phone = patch.phone;
    if (patch.email !== undefined) body.email = patch.email;
    if (patch.idType !== undefined) body.id_type = patch.idType;
    if (patch.idNumber !== undefined) body.id_number = patch.idNumber;
    if (patch.birthday !== undefined) body.birthday = patch.birthday;
    if (patch.sourceId !== undefined) body.source_id = patch.sourceId;
    if (patch.remark !== undefined) body.remark = patch.remark;

    // 乐观锁靠筛选条件实现：版本不符时 PostgREST 匹配不到行并返回空数组，
    // 因此不需要额外的事务或行锁。
    const rows = await client.rest<CustomerRow[]>(
      `customers?organization_id=eq.${encodeURIComponent(organizationId)}&id=eq.${encodeURIComponent(customerId)}&version=eq.${expectedVersion}&deleted_at=is.null&select=${DETAIL_COLUMNS}`,
      {
        method: 'PATCH',
        organizationId,
        headers: { Prefer: 'return=representation' },
        body,
      },
    );
    if (rows.length === 0) return null;
    if (patch.tagIds !== undefined) {
      await replaceTags(organizationId, customerId, patch.tagIds);
    }
    const [decorated] = await decorate(organizationId, rows);
    return decorated ?? null;
  }

  async function softDelete(
    organizationId: string,
    customerId: string,
    actorId: string,
  ): Promise<boolean> {
    const target = `customers?organization_id=eq.${encodeURIComponent(organizationId)}&id=eq.${encodeURIComponent(customerId)}&deleted_at=is.null`;

    // 先确认存在，再提交删除。
    // 不能用 `Prefer: return=representation` 的返回行数判断成功：SELECT 策略会隐藏
    // 已软删除的行，于是 UPDATE 把 deleted_at 置上之后，RETURNING 拿到 0 行，
    // 删除明明成功却会被当成「客户不存在」而回 404。
    const existing = await client.rest<Array<{ id: string }>>(`${target}&select=id&limit=1`, {
      organizationId,
    });
    if (existing.length === 0) return false;

    await client.rest(`${target}`, {
      method: 'PATCH',
      organizationId,
      // 显式 return=minimal：不依赖 PostgREST 的返回体，也就不受读策略影响。
      headers: { Prefer: 'return=minimal' },
      body: {
        deleted_at: new Date().toISOString(),
        deleted_by: actorId,
        updated_at: new Date().toISOString(),
      },
    });
    return true;
  }

  /**
   * 从回收站恢复。
   *
   * 走 RPC 而不是像 softDelete 那样直接 PATCH：已删除的行被 SELECT 策略隐藏，
   * 直接 PATCH 连自己刚删的那一行都看不见；而 restore_customer 是 SECURITY DEFINER，
   * 权限判定在函数内部（customer.restore），绕开「看不见就读不到」的死结。
   */
  async function restore(organizationId: string, customerId: string): Promise<boolean> {
    const restoredId = await client.rest<string | null>('rpc/restore_customer', {
      method: 'POST',
      organizationId,
      body: { requested_customer_id: customerId },
    });
    return Boolean(restoredId);
  }

  async function assertTagsBelongToOrganization(
    organizationId: string,
    tagIds: string[],
  ): Promise<void> {
    if (tagIds.length === 0) return;
    const unique = [...new Set(tagIds)];
    const rows = await client.rest<Array<{ id: string }>>(
      `customer_tags?organization_id=eq.${encodeURIComponent(organizationId)}&id=${inList(unique)}&select=id`,
      { organizationId },
    );
    const found = new Set(rows.map((row) => row.id));
    const missing = unique.filter((id) => !found.has(id));
    if (missing.length > 0) throw new CustomerTagInvalidError(missing);
  }

  async function listTags(organizationId: string): Promise<CustomerTag[]> {
    const rows = await client.rest<TagRow[]>(
      `customer_tags?organization_id=eq.${encodeURIComponent(organizationId)}&select=id,name,color&order=name.asc`,
      { organizationId },
    );
    return rows.map(toTag);
  }

  async function createTag(
    organizationId: string,
    name: string,
    color?: string,
  ): Promise<CustomerTag> {
    try {
      const rows = await client.rest<TagRow[]>('customer_tags', {
        method: 'POST',
        organizationId,
        headers: { Prefer: 'return=representation' },
        body: { organization_id: organizationId, name, color: color ?? null },
      });
      const row = rows[0];
      if (!row) throw new Error('Customer tag creation returned no row');
      return toTag(row);
    } catch (cause) {
      if (cause instanceof RestConflictError) throw new CustomerTagConflictError();
      throw cause;
    }
  }

  return {
    list,
    findById,
    findDuplicatesByPhone: async (organizationId, phone) => {
      const digits = phone.replace(/\D/g, '');
      if (!digits) return [];
      const rows = await client.rest<CustomerRow[]>(
        `customers?organization_id=eq.${encodeURIComponent(organizationId)}&phone_normalized=eq.${encodeURIComponent(digits)}&deleted_at=is.null&select=${LIST_COLUMNS}&order=created_at.desc&limit=5`,
        { organizationId },
      );
      return decorate(organizationId, rows);
    },
    create,
    update,
    softDelete,
    restore,
    assertTagsBelongToOrganization,
    listTags,
    createTag,
  };
}

export function customerRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): CustomerRepository {
  return environment.CUSTOMER_REPOSITORY ?? createSupabaseCustomerRepository(environment, token);
}
