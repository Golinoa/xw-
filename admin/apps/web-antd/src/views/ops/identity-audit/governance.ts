/**
 * 治理域（成员 / 角色）页面级纯逻辑。
 *
 * 单独抽出来是为了能直接单测：这些判断决定「能不能点提交」，
 * 藏在组件里就只能靠挂载测试覆盖，成本高且容易写成「渲染断言」而非「规则断言」。
 *
 * 三条原则：
 * 1. **没有版本号就不让改**：`PATCH /operators/{id}` 要求 `version`，而列表项不一定返回它。
 *    此时禁用编辑并说明原因，比伪造一个版本号去覆盖别人的改动安全得多。
 * 2. **权限并集只作预览**：前端按角色算出的权限集合仅用于展示「这个人大概能做什么」，
 *    真正的授权由服务端按动作码判定；文案里必须写明，否则会被当成授权依据。
 * 3. **变更摘要只描述事实**：`permissionsChanged` 由服务端返回，前端只负责措辞，
 *    不自己算「移除后还剩什么」。
 */
import type {
  OpsOperatorListItem,
  OpsPermissionItem,
  OpsRoleDetail,
} from '#/api/ops/identity';

export interface EditGuard {
  editable: boolean;
  /** 不可编辑的原因（直接展示给用户，不要只说「不可用」）。 */
  hint?: string;
}

/**
 * 成员是否可编辑。
 *
 * `version` 缺失时禁用——契约 §5.1 已定稿要在列表项返回该字段（U-18，2026-10-30），
 * 但后端尚未实现，且本域没有详情端点可补取，前端此刻仍无处取得乐观锁版本。
 * 所以行为不变（继续禁用），变的只是原因：从「契约缺口」变成「等后端实现」。
 */
export function operatorEditGuard(row: OpsOperatorListItem): EditGuard {
  if (typeof row.version !== 'number') {
    return {
      editable: false,
      hint: '后端未返回乐观锁版本（version），无法安全修改；契约 U-18 已定稿该字段，等后端在 GET /operators 返回后自动可编辑',
    };
  }
  return { editable: true };
}

/** MFA 当前值是否可信：列表项没返回时只能按 false 预填并提示。 */
export function mfaValueTrusted(row: OpsOperatorListItem): boolean {
  return typeof row.mfaRequired === 'boolean';
}

export interface PermissionGroup {
  domain: string;
  items: OpsPermissionItem[];
}

/** 权限目录按域分组（域的展示顺序按首次出现顺序，不排序，保持后端下发顺序）。 */
export function groupPermissions(
  items: OpsPermissionItem[],
): PermissionGroup[] {
  const groups = new Map<string, OpsPermissionItem[]>();
  for (const item of items) {
    const list = groups.get(item.domain);
    if (list) {
      list.push(item);
    } else {
      groups.set(item.domain, [item]);
    }
  }
  return [...groups.entries()].map(([domain, groupItems]) => ({
    domain,
    items: groupItems,
  }));
}

export interface PermissionDiff {
  added: string[];
  removed: string[];
}

export function diffPermissions(
  before: readonly string[],
  after: readonly string[],
): PermissionDiff {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: [...afterSet].filter((code) => !beforeSet.has(code)).toSorted(),
    removed: [...beforeSet].filter((code) => !afterSet.has(code)).toSorted(),
  };
}

export function hasPermissionChange(diff: PermissionDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0;
}

/** 变更摘要文案：没有变化时明确说「未变更」，不要留空让用户猜。 */
export function summarizePermissionDiff(diff: PermissionDiff): string {
  if (!hasPermissionChange(diff)) {
    return '权限未变更';
  }
  const parts: string[] = [];
  if (diff.added.length > 0) {
    parts.push(`新增 ${diff.added.length} 项`);
  }
  if (diff.removed.length > 0) {
    parts.push(`移除 ${diff.removed.length} 项`);
  }
  return parts.join('、');
}

/** 角色码 → 角色定义（保持传入顺序，未知码忽略——后端可能已删该角色）。 */
export function rolesForCodes(
  roles: readonly OpsRoleDetail[],
  codes: readonly string[],
): OpsRoleDetail[] {
  return codes.flatMap((code) => {
    const role = roles.find((item) => item.code === code);
    return role ? [role] : [];
  });
}

/**
 * 角色权限并集（**仅用于界面预览**）。
 *
 * 与后端 `operator_roles → role_permissions` 的并集语义一致，但前端算出来的结果
 * 不参与任何授权判断：服务端每个请求都重新判定（契约 §3.9「禁用/撤销角色即时生效」）。
 */
export function permissionCodesOfRoles(
  roles: readonly OpsRoleDetail[],
  codes: readonly string[],
): string[] {
  const permissions = new Set<string>();
  for (const role of rolesForCodes(roles, codes)) {
    for (const permission of role.permissions) {
      permissions.add(permission);
    }
  }
  return [...permissions].toSorted();
}

/** 角色是否可编辑：系统角色不可改 code、不可删除，但可改名称/权限（契约 §5.1）。 */
export function roleEditGuard(role: OpsRoleDetail): EditGuard {
  if (role.isSystem) {
    return {
      editable: true,
      hint: '系统角色：不可修改 code、不可删除；名称与权限可调整',
    };
  }
  return { editable: true };
}

/** 成员角色选择的校验：至少一个角色（契约 §3.9「一个账号至少一个角色」）。 */
export function validateRoleSelection(codes: readonly string[]): null | string {
  return codes.length === 0 ? '至少保留一个角色' : null;
}

/** 原因必填（高风险动作 `operator.manage` / `role.manage` 要求填写原因并写审计）。 */
export function validateReason(reason: string): null | string {
  return reason.trim() === '' ? '请填写变更原因（会写入审计）' : null;
}
