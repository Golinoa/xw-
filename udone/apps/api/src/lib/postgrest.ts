/**
 * PostgREST 查询串的拼接工具。
 *
 * 这些函数只做字符串处理，不发起请求；单独放在这里是因为「关键词清洗」和
 * 「IN 列表编码」在客户、订单、财务三个模块里都要用，抄第三遍的时候就该合并了。
 * 三处各写一份的后果不是代码重复，而是**安全语义漂移**：某天有人在其中一处
 * 补了转义、另外两处没补，搜索型注入就从没补的那两个入口进来了。
 */

/** PostgREST `in.(a,b,c)` 的值列表。逐项编码，避免 id 里的特殊字符截断表达式。 */
export function inList(values: readonly string[]): string {
  return `in.(${values.map((value) => encodeURIComponent(value)).join(',')})`;
}

/**
 * 清洗用户输入的关键词。
 *
 * PostgREST 把 `or=(...)` 与 `ilike.*x*` 当作**结构化查询语法**解析，逗号分层、
 * 括号分组、`*` 是通配符。用户输入里出现这些字符会改变查询结构，而不只是
 * 让匹配不到东西——所以统一替换为空格，然后折叠连续空白。
 * 这不是转义，是降级：宁可搜得粗一点，也不让输入决定查询形状。
 */
export function sanitizeKeyword(keyword: string): string {
  return keyword
    .replace(/[,()*%\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `ilike` 的包含匹配模式。调用前必须先 `sanitizeKeyword`。 */
export function ilikePattern(keyword: string): string {
  return `*${keyword}*`;
}
