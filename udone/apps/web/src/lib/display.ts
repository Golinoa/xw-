/**
 * 表格里的枚举取值。
 *
 * 存在的原因有两个，都不是「为了好看」：
 *
 * 1. `a-table` 的 `#bodyCell` 插槽把 `record` 标注成 `any`。用 `any` 去索引
 *    `Record<枚举, string>` 会触发 TS7053，也就是说模板里这一行过不了
 *    `vue-tsc`——而模板恰恰是最该被检查的地方。
 * 2. 服务端新增一个枚举值时，前端旧表里没有对应项，`map[value]` 得到
 *    `undefined`，单元格渲染成空白。空白比报错更难查：看不出是「没有值」
 *    还是「不认识这个值」。回退值让「不认识」这件事显式可见。
 *
 * 用 `hasOwnProperty` 而不是 `value in map`：`in` 会命中原型链，
 * `'toString' in labels` 为真，于是把一个函数当标签渲染出去。
 */
export function lookup<K extends string>(
  map: Record<K, string>,
  value: unknown,
  fallback = '—',
): string {
  if (typeof value !== 'string') return fallback;
  return Object.prototype.hasOwnProperty.call(map, value) ? map[value as K] : fallback;
}
