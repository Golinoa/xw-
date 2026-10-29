/**
 * 菜单。
 *
 * 契约 `Docs/ops-api-contract.md` §5 没有菜单端点：运营导航由前端静态路由 +
 * 权限动作码过滤生成（设计文档 §2.3.3「菜单隐藏不是授权」），后端只提供
 * `/session` 的 `permissions`。
 *
 * 因此这里**不伪造**菜单端点：`preferences.app.accessMode = 'frontend'` 时本函数不会被调用
 * （`generateAccessible` 只在 backend 模式拉取菜单）。若有人切到 backend 模式，
 * 明确抛错比返回空列表更容易定位——空菜单会表现成"登录成功但一片空白"。
 */
import type { RouteRecordStringComponent } from '@vben/types';

export async function getAllMenusApi(): Promise<RouteRecordStringComponent[]> {
  throw new Error(
    '[ops] 运营后台没有服务端菜单端点：请使用 accessMode="frontend" 的静态路由 + 权限码过滤',
  );
}
