/**
 * 部署域类型（deployment）。
 *
 * 真源：`Docs/ops-api-contract.md` §3.7（数据模型 / 禁用列清单 / 状态机）与 §5.8（端点），
 * PRD §6.8（台账字段）。
 *
 * 规则：
 * 1. 字段名严格照抄契约（`instance_no` → `instanceNo`，`maintenance_until` →
 *    `maintenanceUntil`，`from_version`/`to_version` → `fromVersion`/`toVersion`）；
 * 2. 契约未给出的形态显式标注「契约推导」，渲染层必须能降级（不整页返工）：
 *    - 实例列表的「最后上报时间」：契约 §3.7 无心跳/上报列，§5.8 列表响应也没有；
 *      这里用最近一条版本升级记录的登记时间 `lastVersionRecordAt`，并由页面注明口径；
 *    - `deploymentType` / `productId` 两个筛选为推导项（见 `endpoints.ts` 头注释）；
 * 3. **禁止出现任何远程登录凭据字段**（契约 §3.7 禁用列清单：ssh/密码/token/
 *    connection string/安装包地址）。本文件不定义也不透传任何此类字段；
 * 4. 版本号是**不透明字符串**（`v1.2.3` / `1.2.3+hotfix` 都可能），只做展示与
 *    相等比较，不排序、不解析、不规范化。
 */

/** 实例状态（契约 §3.7 状态机；与 PRD §8「私有化实例」同一枚举）。 */
export type DeploymentInstanceStatus =
  | 'active'
  | 'maintenance'
  | 'planned'
  | 'retired';

/** 部署类型（契约 §3.7 `deployment_type`；值域为契约 U-10 推导）。 */
export type DeploymentType = 'dedicated' | 'private';

/** 升级结果（契约 §3.7 `result`，三个值，不得增删）。 */
export type VersionRecordResult = 'failed' | 'rolled_back' | 'succeeded';

/**
 * 实例状态动作（契约 §3.7 状态机）。
 * `create` 不是 transition 动作——创建由 `POST /deployments` 完成（状态直接落 `planned`）。
 */
export type DeploymentTransitionAction =
  | 'end_maintenance'
  | 'go_live'
  | 'retire'
  | 'start_maintenance';

/** 分页查询公共参数（契约 §2.4）。 */
export interface DeploymentPageQuery {
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
  sort?: string;
}

/** 分页响应公共形态（契约 §2.4）。 */
export interface DeploymentPagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/** 操作者引用：契约表格列是 `uuid`，展示需要姓名，两种形态都要能渲染。 */
export type DeploymentActorRef = string | { displayName?: string; id: string };

/** 客户引用（契约 §5.8 内嵌 `customer{...}`）。 */
export interface DeploymentCustomerRef {
  customerNo?: string;
  id: string;
  name: string;
}

/** 负责人引用（契约 §5.8 列表内嵌 `owner{...}`，`owner_operator_id`）。 */
export interface DeploymentOwnerRef {
  displayName?: string;
  id: string;
}

/**
 * 关联私有授权摘要（契约 §5.8 详情返回 `licenses[]`）。
 *
 * 只收「合规可见」的字段：授权号、方式、有效期、维护期。**不含**任何环境凭据。
 * `licenseMode='perpetual'` 时 `validTo` 为 `null`（授权域 CHECK），维护期必须单独展示
 * ——永久授权 ≠ 永久更新（PRD §6.6，本域页面再次显式提示）。
 */
export interface DeploymentLicenseRef {
  id: string;
  licenseMode?: null | string;
  licenseNo: string;
  maintenanceUntil?: null | string;
  status?: null | string;
  validFrom?: null | string;
  validTo?: null | string;
}

/** 关联工单摘要（契约 §5.8 详情返回 `tickets[]`，字段契约未细化 → 只读摘要）。 */
export interface DeploymentTicketRef {
  id: string;
  priority?: null | string;
  status?: null | string;
  subject?: null | string;
  ticketNo?: null | string;
}

/** 版本升级记录（契约 §3.7 `ops.deployment_version_records`，**仅 INSERT**）。 */
export interface DeploymentVersionRecord {
  createdAt?: null | string;
  /** `executed_on`，纯日期 `YYYY-MM-DD`（契约 §2.3）。 */
  executedOn: string;
  executedBy?: DeploymentActorRef | null;
  fromVersion: string;
  id?: string;
  impactNote?: null | string;
  instanceId?: null | string;
  result: VersionRecordResult;
  rollbackNote?: null | string;
  toVersion: string;
}

/** 部署实例（契约 §3.7 `ops.deployment_instances` + §5.8 列表条目）。 */
export interface DeploymentInstance {
  contractId?: null | string;
  /** 当前版本，未上线时可为空。不透明字符串。 */
  currentVersion?: null | string;
  customer: DeploymentCustomerRef;
  /** 部署类型：`private`（客户自有环境）/ `dedicated`（托管独享）。 */
  deploymentType: DeploymentType;
  /** 客户环境标识（PRD §6.8「客户环境标识」），人工填写的可读标识，不是地址。 */
  environmentRef?: null | string;
  /** 上线日期（纯日期）。 */
  goLiveOn?: null | string;
  id: string;
  instanceNo: string;
  /**
   * 契约推导：最近一条版本升级记录的登记时间，用于列表「最后上报时间」列。
   * 缺失时页面显示「—」并提示口径，不伪造心跳。
   */
  lastVersionRecordAt?: null | string;
  licenseId?: null | string;
  /** 维护期到期日（纯日期）。到期后不再包含版本更新与技术支持。 */
  maintenanceUntil?: null | string;
  name: string;
  owner?: DeploymentOwnerRef | null;
  status: DeploymentInstanceStatus;
  /** 乐观锁版本：任何状态动作必须回传。 */
  version?: number;
}

export interface DeploymentListQuery extends DeploymentPageQuery {
  /** 当前版本精确匹配（不透明字符串，区分大小写）。 */
  currentVersion?: string;
  customerId?: string;
  /** 环境类型筛选（契约推导：§5.8 未列，实例自有列）。 */
  deploymentType?: DeploymentType;
  /** 维护期到期日上界（含当日），用于「维护期将到期 / 已到期」筛选。 */
  maintenanceUntilBefore?: string;
  /** 产品筛选（契约推导：需服务端经授权关联聚合，见 README）。 */
  productId?: string;
  status?: DeploymentInstanceStatus[];
}

export type DeploymentListResult = DeploymentPagedResult<DeploymentInstance>;

/** 实例详情（契约 §5.8 `GET /deployments/{id}`）。 */
export interface DeploymentDetail {
  deployment: DeploymentInstance;
  licenses: DeploymentLicenseRef[];
  tickets: DeploymentTicketRef[];
  versionRecords: DeploymentVersionRecord[];
}

export interface CreateDeploymentInput {
  currentVersion?: string;
  customerId: string;
  deploymentType: DeploymentType;
  environmentRef?: string;
  goLiveOn?: string;
  licenseId?: string;
  maintenanceUntil?: string;
  name: string;
  ownerOperatorId?: string;
}

export interface CreateDeploymentResult {
  deployment: DeploymentInstance;
}

/**
 * 可编辑字段（契约 §5.8 `PATCH /deployments/{id}`「可编辑字段 + version」）。
 *
 * `status` / `currentVersion` 均**不在**可编辑字段内：状态只能走 `transition`，
 * 当前版本只能由升级登记推进（契约 §3.7 状态机 + §5.8 version-records 响应）。
 */
export interface UpdateDeploymentInput {
  environmentRef?: string;
  goLiveOn?: null | string;
  maintenanceUntil?: null | string;
  name?: string;
  ownerOperatorId?: null | string;
  version: number;
}

export interface UpdateDeploymentResult {
  deployment: DeploymentInstance;
}

export interface DeploymentTransitionInput {
  action: DeploymentTransitionAction;
  /** `retire` 必须填写（契约 §3.7 状态机「需 reason」）。 */
  reason?: string;
  version: number;
}

export interface DeploymentTransitionResult {
  deployment: {
    allowedActions?: string[];
    currentVersion?: null | string;
    status: DeploymentInstanceStatus;
    version: number;
  };
}

/**
 * 升级登记入参（契约 §5.8 `POST /deployments/{id}/version-records`）。
 *
 * `fromVersion` 必须等于实例当前版本，否则 409 `STATE_CONFLICT` +
 * `details.reason='VERSION_MISMATCH'`——前端在提交前用纯规则先拦一次。
 */
export interface CreateVersionRecordInput {
  executedOn: string;
  fromVersion: string;
  impactNote?: string;
  result: VersionRecordResult;
  rollbackNote?: string;
  toVersion: string;
}

export interface CreateVersionRecordResult {
  /** 服务端可能只回 `id`，也可能回整条记录；两种都要能渲染。 */
  versionRecord: Partial<DeploymentVersionRecord> & { id: string };
  deployment?: { currentVersion?: null | string };
}

export interface VersionRecordListResult {
  items: DeploymentVersionRecord[];
}
