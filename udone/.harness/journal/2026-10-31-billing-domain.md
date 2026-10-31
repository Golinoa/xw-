# 2026-10-31 · billing 域（T-07）与参数表

## 今日完成

`o-t07` 应收计划与展期，两个提交：

- `af06beb` 参数表 + billing 两表 + 七个函数 + 50 条 pgTAP；连带改
  `get_contract` 的 `receivables[]`、重生成 `db-schema.md`。
- `dfd6dab` 契约、四个端点、25 条单测、20 条集成（集成文件总数 202）。

`ops.settings` 是顺手先落的：三个键被 `overview` 的临期窗口（o-t13）、工单的
内部时限（o-t12 的 `isOverdue`）、导出的保留天数（o-t13）共用。按域落地的话
`o-t12` 要先造替身表、`o-t13` 再换回真表，中间那版还要写迁移与回滚；表只有四列，
先落没有额外成本。端点（`GET/PATCH /settings`）仍归 `o-t13`：读要 `settings.manage`、
写要范围校验与审计，那是设置页整体的一部分。

## 关键决策

1. **应收状态不落库。** 契约 §3.4 明确「派生值」，理由是逾期会随时间自己发生：
   落库就必须有定时任务去刷 `status`，而任务没跑或跑错的那段时间里，列表、总览、
   报表会各说一套。`ops.receivable_status` 是唯一判据，列表筛选、详情、合同摘要
   都调它，「图表与列表同一口径」才成立。
2. **「今天」按 `Asia/Shanghai` 算。** 服务器在 UTC 时，北京时间 00:00–08:00 的
   `current_date` 还是前一天，逾期判定整体晚一天。落成 `ops.receivable_today()`
   单点定义，不散在各函数里写 `now() at time zone ...`——散写迟早有一处漏。
3. **计划合计必须等于合同金额，一分不差。** 不做「差额自动补到最后一期」：那会把
   「合同 12 万、计划 11.9 万」这种录入错误变成一张看起来正常的尾差计划，等到
   对账才发现少收了一千。失败时同时给 `plannedTotal` 与 `contractTotal`，用户才知道
   差多少。
4. **展期只允许未结清，且必须带 `version`。** 已结清展期没有业务意义，还会让
   「按期收款率」把已收的钱重新算成未来应收。版本是乐观锁：两人同时展期同一期时，
   后到的必须看见冲突——否则前一次的新日期被覆盖，而 `receivable_extensions` 里
   两次展期只剩一条（记录被覆盖前只写一条，另一条根本没写），审计上看起来只展期过
   一次。新到期日必须**严格晚于**当前日期：同日「展期」是改备注。
5. **展期保留原到期日。** `receivables.due_date` 被新日期覆盖，历史只能从
   `receivable_extensions.previous_due_date` 读回来——这正是契约要求「追加展期
   记录」而不是「改到期日」的原因。
6. **合同详情里的 `receivables[]` 必须换形状。** T-06 落地时这张表不存在，
   `get_contract` 用 `to_regclass` 守卫生成 `jsonb_agg(to_jsonb(entry))`——原始行
   透传，键名是表列、没有 `status` / `outstanding`。表一落地就会把 snake_case 原始行
   直接吐给前端，且缺两个最常用的字段。用 `CREATE OR REPLACE` 覆盖同一个函数，
   不改 T-06 的迁移（迁移是历史，改它等于让已跑的库与文件不一致）。
7. **汇总口径自洽：`settled + outstanding = total`。** 第一版写的是「只统计 paid 期的
   已收」，实测出来 settled 0 + outstanding 8000 ≠ total 12000——因为「已收」不是
   「paid 期的未收额」。改成「全量核销净额」与「全量未收余额」两个互补式子，
   overdue 只是 outstanding 里逾期那一块（子集，而不是另一种算法）。
8. **`settings` 三个默认值是推导。** `overview.expiryWindowDays` 30 天（§5.9 明写
   「默认 30」）、`ticket.dueHours` 48 小时、`retention.exportDays` 90 天。后两个
   契约只给了范围（1–720 / 1–365），没给初值。记进迁移注释与看板协作项，等运营端确认。

## 遇到的问题

- **`numeric(14,2)` 的变量会静默舍入，把「两位小数」校验整条绕过。**
  `entry_amount numeric(14,2) := (entry->>'amount')::numeric` 对 `6000.005` 得到
  `6000.01`，于是 `entry_amount <> round(entry_amount, 2)` 永远为假，校验形同不存在。
  是 pgTAP 的 C5 断言（期望 `amount_scale_invalid`，实际拿到 `plan_total_mismatch`）
  逼出来的：断言写对了，才会发现守卫从来没生效过。改成无精度 `numeric`。
- **`jsonb_agg(... order by item_id)` 按 uuid 排。** 创建计划返回的 items 顺序是
  `[3,2,1]`——集成测试断言 `[1,2,3]` 才抓到。前端拿 `items[0]` 当首期就是错的，
  而且时对时错。改成按 `period_no` 排。
- **contract 的 pgTAP 替身表第三次撞名。** 第三次了（catalog 落地时一次、合同落地时
  一次）。`CREATE TABLE ops.receivables` 撞上真表，整个文件在 setup 阶段中断。
  改成插真实行：替身表只有两列，真表的 CHECK、唯一键、客户外键一并被那行数据走了一遍。
- **集成 harness 默认注入幂等键，「缺键必须 400」在集成层根本无法表达。**
  `headers` 只能覆盖值、不能删键；传空串会被 fetch 整条丢掉，测出来的是「键为空」
  而不是「没有键」。补 `omitIdempotencyKey` 选项，写清为什么不能用空串代替。
- **集成测试里以 authenticated 身份直连业务表。** `select id from ops.receivables`
  报 `permission denied for table receivables`——那不是被测代码的问题，是测试在用
  端点拿不到的权限。改成把 id 提到会话变量（`current_setting`），与端点走同一条路。
- **用例设计耦合了一次。** 展期对象选了第 2 期（逾期那期），展期后 overdue 消失，
  连带 L5/L6/L7 三条断言同时红。把展期改到第 3 期（未到期）才让「逾期筛选」与
  「展期」两个断言各管一件事。
- **13 道门禁里 `schema:check` 先红。** 新增两张表后 `db-schema.md` 过期，这是设计
  如此：结构变了文档必须跟着变，否则文档就是另一种口径。`pnpm schema:generate` 后通过。

## 未验证项

1. **已结清不可展期在集成层证不了**：结清需要核销，而核销表属 T-08。集成层造不出
   已结清的应收，这条由 pgTAP 直接改 `allocated_amount` 证明（E1）。
2. **`allocations[]` / `reversals[]` 恒为空数组**：只证明了「缺表时是空数组而不是
   缺键」，没证明真实数据下的形状。
3. **`settings` 三个默认值是推导**（见决策 8），需运营端确认后定稿。
4. **业务域审计写入整体缺失**：`ops.write_audit` 存在，但客户域、catalog 域、合同域、
   billing 域**一处都没调用**。契约只对少数动作明写「写审计」（收款 reject、核销、
   租户命令），所以四个域都不算违反条文；但高风险动作列表与审计页的口径要求写。
   这是跨域改造（要统一动作词与前后摘要格式），单独一轮做，已上卡 `o-audit-write`。
5. **展期没有次数上限**：契约没要求，实现也就没加。连续展期 20 次不会拦——如果
   业务上需要「最多展期 N 次」，那是一条新规则，不该由实现顺手加。

## 下一步计划

- `o-t12` 售后工单可以开工了：`ops.settings` 已在、`ticket.dueHours` 可直接
  `ops.setting_int('ticket.dueHours', 48)` 取，`isOverdue` 按 `Asia/Shanghai` 判
  `due_at < now()`——`ops.receivable_today()` 是日期口径，工单要的是时刻，不要直接复用。
- `o-t08` 收款是下一个大件，依赖本域的 `UNIQUE (id, customer_id, currency)`
  （复合外键落点已建好）。风险最高，单独一轮、不并行。
- `o-t09` 订阅权益与 `o-t10` 租户映射可以并行，两者只共享 `routes.ts` 末尾追加
  这一处写点（串行）。

## 断点（2026-10-31 12:40）

- 分支 `feat/business-slice`，两个提交 `af06beb`（DB）+ `dfd6dab`（端点），工作树干净。
- 13 道门禁一次跑完退出码 0：25 迁移 / 19 文件 / 705 断言；集成 11 文件 202 条；
  单测 49 文件 528 例；build 主 chunk 1,638.75 kB（无增长）；
  deps:audit critical 0 / high 0 / moderate 1（`minimatch`）/ low 0；licenses 349 组。
- 变异两枪：已结清守卫 `>=`→`>`（E1、L7 红）；状态过滤 `or true`（L5 红）；复原均绿。
- 看板回写已在下一节完成（`o-t07` → done、`o-audit-write`、`C-106` / `C-107`、
  `SEED_VERSION` 37）。

## 追加（13:05）· 看板已回写

`o-t07` → done，卡上写了两个提交与八条决策、两个被断言逼出来的缺陷、四条未验证项；
新增 `o-audit-write`（todo，跨域口径四条先定再动手）；协作项 `C-106` / `C-107`
落 waiting。`SEED_VERSION` 36 → 37，`pnpm board:check` 通过：
101 张卡（70 done / 0 doing / 28 todo / 3 blocked）、协作 26 项（10 未闭环）。

两处与上面计划不同，记一笔：

- `C-106` 实际写成「三个 `details.reason` + 两个审计词（延后）」。原先只记了
  「billing 两个审计词待回写 §6.4」，重新对着迁移与路由核了一遍才发现：本域真正
  缺的是 `CONTRACT_NOT_ACTIVE` / `PLAN_EXISTS` / `INVALID_DUE_DATE` 三个 reason，
  而审计词一个都还没产生（billing 没有任何审计写入）——把没产生的词登记进词表，
  等于造出「词表有、库里永远查不到」的空词。所以词表回写等 `o-audit-write`，
  这一轮只回写 reason。
- `board:check` 第一次就红在「第一人称」判据上：C-106 的 `need` 里写了「我们的
  倾向是」。这条判据本就是为「两端都看这块看板」设的，改判自己也该走同一条门禁，
  改成「业务端的倾向是」。第八条判据自 4023c34 加进来之后第一次真正拦下东西。

