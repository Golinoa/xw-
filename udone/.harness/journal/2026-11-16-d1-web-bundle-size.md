# D1 前端产物体积

日期：2026-11-16 · 卡片：D1（P2）· 出口：主 chunk < 500 kB，或给出「为什么不能拆」的结论

## 问题

构建每次都在报 `Some chunks are larger than 500 kB after minification`，卡片记的是
1,638.00 kB，本轮实测已经涨到 **1,871.64 kB / gzip 567.34 kB**。

根因不是「没做 code splitting」——路由一直是动态 import，各视图早已切成独立 chunk
（`OrderListView` 64 kB、`CustomerListView` 27 kB…）。真正的问题在入口：

```ts
app.use(Antd);   // main.ts
```

`ant-design-vue/es/index.js` 的默认导出 install 长这样：

```js
export const install = function (app) {
  Object.keys(components).forEach(key => { if (components[key].install) app.use(components[key]); });
  ...
};
```

它把 `components` 命名空间里**每一个**组件都引用了一遍。Rollup 的 tree-shaking 判断
「这个模块有没有副作用引用」，而 `Object.keys(components)` 是动态遍历，静态分析看不到
边界，于是全量 70 个组件、连同它们各自的 `vc-*` 依赖、style、图标全部进包。
**卡片里那句「顺手核对 ant-design-vue 按需加载是否生效」的答案是：从来没生效过。**

## 决策

1. **改成显式注册清单（27 个组件），不再 `app.use(Antd)`。**
   清单放在 `apps/web/src/design-system/antd-registration.ts`，`main.ts` 只负责
   `forEach(app.use)`。子组件不用逐个列：antd 的 install 会连带注册（实测探测，
   例：`Form` → `AForm`/`AFormItem`/`AFormItemRest`，`Input` → `AInput`/`ATextarea`/
   `AInputSearch`/`AInputPassword`，`DatePicker` → `ADatePicker`/`ARangePicker`，
   `Typography` → `ATypographyTitle`/`Paragraph`/`Text`/`Link`）。

2. **把 `StyleProvider` 从清单里删掉。** 它原来由 `app.use(Antd)` 注册，但
   `app.use` 只做 `app.component('AStyleProvider', …)`——只有在模板里用
   `<a-style-provider>` 包住整棵树才生效，而本仓从来没有包过。删掉行为中立：
   `useStyleInject()` 自带 `defaultStyleContext` 兜底（`_util/cssinjs/StyleContext.js:70`）。

3. **加一条守卫测试。** 手写清单引入一种新的失败形态：新界面用了没注册的组件，
   构建不报错、`vue-tsc` 不报错，只在浏览器里渲染成空白标签。所以
   `antd-registration.test.ts` 做两件事——把注册清单喂给假 app 探测出真正注册的标签名，
   再扫全部 `.vue` 模板里的 `<a-*>`
   （`AFormItem` → `a-form-item` 就是 antd 的命名规则，不需要维护第二份映射表）；
   反方向检查清单里没有无人使用的组件（父组件算「被用到」的条件是任一子标签被用到）。

4. **`manualChunks` 按生态切**：`vendor-vue` / `vendor-antd` / `vendor-supabase` / `vendor`。
   目的不是缩小首屏总量（切完总量不变），是让业务代码改动不再让 895 kB 的 antd 缓存失效。

5. **不再把 `vendor-antd` 往 500 kB 以下硬拆。** 三条路都算过：
   - 换组件库：不做，几十个页面的交互与视觉全部要重写；
   - 分页面局部注册，把 `Table`/`DatePicker` 挪出首屏：**只是推迟，总量不减**，
     而且会让「标签能不能解析」从全局清单变成每个文件的局部绑定，现在没有列表页的
     浏览器覆盖（A1 还没做），改错了没人发现。收益约 66 kB gzip，风险是 6 个列表页白屏；
   - 把 antd 拆成多个 <500 kB 的 chunk：纯粹把警告藏起来，请求数变多、首屏一字节不少。

   选第二条但不在本卡做，等 A1 有浏览器回归之后再上。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `apps/web/src/design-system/antd-registration.ts` | 新增：27 个组件的显式注册清单 + 为什么不用 `app.use(Antd)` |
| `apps/web/src/design-system/antd-registration.test.ts` | 新增：模板标签 ↔ 注册清单的双向守卫 |
| `apps/web/src/main.ts` | `app.use(Antd)` → `antdComponents.forEach(app.use)` |
| `apps/web/vite.config.ts` | 新增 `build.rollupOptions.output.manualChunks` |

## 验证

| 产物 | 改前 | 改后 |
| --- | --- | --- |
| 入口 `index.js` | **1,871.64 kB** / gzip 567.34 | **38.04 kB** / gzip 12.52 |
| `vendor-vue` | （在 index 里） | 103.94 / 40.61 |
| `vendor`（zod、async-validator、dom-align…） | （在 index 里） | 208.87 / 65.87 |
| `vendor-supabase` | （在 index 里） | 217.40 / 56.99 |
| `vendor-antd` | （在 index 里） | 895.19 / 269.81 |
| **首屏 JS 合计** | **1,871.64 / 567.34** | **1,463.44 / 445.80（−21.8% / −21.4%）** |

主 chunk 从 1,871.64 kB 降到 **38.04 kB**，卡片出口达成。总量也真降了 408 kB——
不是靠切 chunk 把数字搬家，是全量注册里那 43 个没人用的组件真的被摇掉了。

| 门禁 | 结果 |
| --- | --- |
| pgTAP | **36 文件全绿**（本卡没动数据库，跑一遍防回归） |
| 单元测试 | **64 文件 / 851 用例**（改前 63 / 849，新增本卡 2 条） |
| 类型检查（api + web） | 0 错误 |
| eslint + CSS token | 通过 |
| 构建 | 通过（`vendor-antd` 仍超 500 kB 阈值，见下） |

**变异验证**：把 `Table` 从注册清单里删掉，守卫测试立刻变红并精确报出 11 处模板使用点
（`CustomerListView`、`OrderListView`、`SupplierListView`、`FinanceListView`、
`OrderDetailDrawer` 等）。这证明守卫是拿真实的 install 注册名在比对，不是把清单抄了两遍。

**真实浏览器验证**（这次唯一能发现「组件没注册」的手段）：`vite preview` 起 dist，
Chromium 打开 `/login`，`登录` 标题可见、2 个输入框、2 个按钮、
`Failed to resolve component` 零条、页面级异常零条。

**边界**：只验证了登录页。列表页（Table/DatePicker/Tabs）靠的是上面的静态守卫，
真正的浏览器覆盖属于 A1。

**`vendor-antd` 895 kB 的构成**（都是真在用的，没有可删项）：

| 大小 | 模块 | 谁在用 |
| --- | --- | --- |
| 39.3 kB | `date-picker/style` | 客户/订单/收款表单的日期字段 |
| 34.2 kB | `vc-tree/Tree` | `Table` 的 `useSelection`（客户批量打标要勾选） |
| 32.3 kB | `vc-picker/RangePicker` | 订单列表的日期区间筛选 |
| 24.8 kB | `vc-select/BaseSelect` | 客户来源、线路、供应商下拉 |
| 23.4 kB | `input/style` | — |
| 22.4 kB | `tabs/style` | 财务页「应收/应付」 |
| 20.9 kB | `vc-pagination` | 全部列表 |
| 18.3 kB | `result/serverError` | 错误态插图 |

## 未做

- **列表页的浏览器验证**：归 A1。本卡只做到「静态守卫 + 登录页实测」。
- **分页面局部注册**（把 `Table`/`DatePicker` 移出首屏，约 −66 kB gzip）：理由见决策 5，
  等 A1 的浏览器回归铺好再做。
- **zod 在首屏约占 150~180 kB**：来自 `@erp/contracts` 对响应体的运行时校验，是有意设计
  （契约一致 = 前端不能绕过校验）。要减得动 contracts 的校验层，不在本卡。

## 顺手发现（不在本卡范围）

1. **`pnpm format:check` 在仓库范围是红的**：225 个文件不合格，其中包括本卡一个字没碰的
   `apps/web/src/router/index.ts`。根因和之前 `format:sql:check` 那次同类——工作区是 CRLF、
   prettier 配置按 LF 判。本卡只保证自己新增的 4 个文件合格（`prettier --check` 单独跑过），
   没有对全仓 `--write`，否则会带出一个 225 文件的无关大 diff。
2. `udone/apps/{api,web}/.nm-bad/` 两个目录还在，`git status` 每次都刷
   `warning: could not open directory ... Function not implemented`。历史残留，未动。
