/**
 * 运营领域 API 客户端。
 *
 * 每个域一个目录，`index.ts` 只导出该域的请求函数与类型（按 `Docs/ops-api-contract.md` §5 分节）。
 * 域内不得处理错误、不得弹提示、不得跳转——这些统一由 `#/api/request` 的适配层负责。
 *
 * 当前只有 identity 域落地（会话/权限目录）；其余域见各自 README。
 */
export * from './identity';
