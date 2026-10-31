import { describe, expect, it } from 'vitest';
import { ROUTE_REGISTRIES } from '@erp/contracts';
import { call, signToken, USERS } from './harness';

/**
 * 契约 §7.4 里 **API 层**的两行：P11 与 P12。
 *
 * ## 为什么这两条必须表驱动，而不是每个域各写一条
 *
 * P12 的原文是「无 token 调用**任意** ops 端点 → 401」，P11 是「旅行社管理员调用
 * **任意** ops 端点 → 403」。这是全称命题，域内测试只能证明存在量词——每个域文件
 * 里都有一条 `token: ''` → 401，但没有任何一条会因为你**新加的第 121 个端点忘了挂
 * `requireOpsAuth`** 而变红。漏挂的那个端点自己不会写测试，它的域也还没建。
 *
 * 所以这里遍历 `OPS_ROUTES` 全表。代价是两道断言要发两百多个请求，收益是
 * 「哪个端点忘了鉴权」这个问题从「靠人记得」变成「跑一遍就知道」。
 *
 * ## P6 不在这里
 *
 * §7.4 的 P6（无 `customer.sensitive.read` 的人看不到 `phone`/`email` 原值）需要
 * 一条有联系人的客户夹具，且它的正反两面（有权限的人**能**看到原值）已经写在
 * `tests/integration/ops-customers.test.ts` 的「omits the raw keys」两条里。
 * 搬到这里只会多一份会各自漂移的副本。
 */

/**
 * 免鉴权白名单：契约 §5.1 明写只有三个 `/auth/*`。
 *
 * 用**键名枚举**而不是路径前缀匹配：前缀匹配等于「以后谁往 `/auth/` 下加一条
 * 就自动免鉴权」，而免鉴权是最不该有默认值的一类配置。加路由的人必须回来改这里，
 * 那一刻他会看见下面这条「白名单恰好是这三个」的断言，也就知道自己在动鉴权面。
 */
const AUTH_EXEMPT_KEYS = ['postOpsLogin', 'postOpsRefresh', 'postOpsLogout'] as const;

/**
 * 路径参数的占位值。
 *
 * 鉴权在参数校验之前跑，所以值本身无关紧要——但要**是合法 uuid**：万一哪天中间件
 * 顺序变了，`400 invalid uuid` 与 `401` 的区别就会在断言里显形，而不是被一个
 * 恰好能解析的字符串掩盖。
 */
const PLACEHOLDER_ID = '00000000-0000-4000-8000-0000000009f0';

type OpsRoute = { method: string; path: string };

function concretePath(path: string): string {
  return path.replace(/:[A-Za-z]+/g, PLACEHOLDER_ID);
}

const OPS_ROUTES = ROUTE_REGISTRIES.OPS_ROUTES as Record<string, OpsRoute>;

const ALL_ENTRIES = Object.entries(OPS_ROUTES);
const GUARDED_ENTRIES = ALL_ENTRIES.filter(
  ([key]) => !(AUTH_EXEMPT_KEYS as readonly string[]).includes(key),
);

interface Rejection {
  key: string;
  route: string;
  status: number;
  code: string | undefined;
}

async function sweep(entries: [string, OpsRoute][], token: string): Promise<Rejection[]> {
  const results: Rejection[] = [];
  for (const [key, route] of entries) {
    const response = await call<{ code?: string }>(concretePath(route.path), {
      method: route.method,
      token,
      ...(route.method === 'GET' ? {} : { body: {} }),
    });
    results.push({
      key,
      route: `${route.method} ${route.path}`,
      status: response.status,
      code: response.body?.code,
    });
  }
  return results;
}

/** 失败时只列不对的那些，不打印 117 行「这个对了」。 */
function reportOffenders(offenders: Rejection[], expectStatus: number, expectCode: string): string {
  if (offenders.length === 0) return '';
  const lines = offenders
    .slice(0, 12)
    .map((item) => `  ${item.route} → ${item.status} ${item.code ?? '(no code)'}`);
  const more = offenders.length > 12 ? `\n  …另有 ${offenders.length - 12} 个` : '';
  return `\n期望全部 ${expectStatus} ${expectCode}，以下不是：\n${lines.join('\n')}${more}`;
}

describe('P12 no token', () => {
  it('answers 401 AUTH_REQUIRED on every guarded ops endpoint', async () => {
    const results = await sweep(GUARDED_ENTRIES, '');

    const offenders = results.filter(
      (item) => item.status !== 401 || item.code !== 'AUTH_REQUIRED',
    );

    // 空 `Authorization: Bearer ` 与「没有这个头」走的是同一条分支
    // （`slice(7).trim()` 得空串），所以这里测的是「没令牌」而不是「令牌格式错」。
    expect(offenders, reportOffenders(offenders, 401, 'AUTH_REQUIRED')).toEqual([]);
    expect(results.length).toBeGreaterThan(100);
  });

  it('lets no guarded endpoint escape the token check', async () => {
    // 反方向：把**全部**端点跑一遍，没回 401 的那些必须落在白名单里。
    // 只看「守卫的端点都 401」是不够的——一个本该受保护、却因为忘挂中间件
    // 而返回 400/404 的端点，压根不在 GUARDED_ENTRIES 里，永远不被检查。
    //
    // 断言写成「子集」而不是「等于」：`POST /auth/refresh` 没有 cookie 时由
    // **处理函数自己**回 401，与中间件回的那个 401 从外部完全同形。要求相等
    // 就得给它编一个能走通的请求，而那样测的是刷新逻辑，不是鉴权面。
    // 子集已经足够表达要防的事：任何**不在白名单**的端点都不能放过。
    const results = await sweep(ALL_ENTRIES, '');

    const reachable = results.filter((item) => item.status !== 401).map((item) => item.key);

    expect(
      reachable.filter((key) => !(AUTH_EXEMPT_KEYS as readonly string[]).includes(key)),
    ).toEqual([]);

    // 白名单不能烂在代码里：三个键都必须在注册表里真实存在。
    // 少一个，上面那条「子集」会永远成立而毫无信息量。
    for (const key of AUTH_EXEMPT_KEYS) {
      expect(Object.keys(OPS_ROUTES)).toContain(key);
    }
  });
});

describe('P11 tenant administrator', () => {
  it('answers 403 FORBIDDEN on every guarded ops endpoint', async () => {
    // 一个**有** `member.manage` 的租户管理员：他在租户侧权限齐全，在运营侧
    // 没有任何 `ops.operators` 行。两条身份体系的分界线就在这里——403 不是
    // 「令牌无效」（那是 401），而是「令牌有效但你不是这套体系的人」。
    const results = await sweep(GUARDED_ENTRIES, signToken(USERS.admin));

    const offenders = results.filter((item) => item.status !== 403 || item.code !== 'FORBIDDEN');

    expect(offenders, reportOffenders(offenders, 403, 'FORBIDDEN')).toEqual([]);
  });
});
