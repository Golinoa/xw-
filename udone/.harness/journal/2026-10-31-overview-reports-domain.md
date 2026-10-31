# 2026-10-31 · 总览与报表（o-t13 前两块）

## 这一单元做了什么

`o-t13` 是三件事：总览、报表、导出。这一轮做完前两件，两个提交：

```
1ae096c  ops.v_receivable_status + ops.get_ops_overview + /overview
99ebb67  四个 ops.report_* + /reports/{receivables,expiring-entitlements,
         tenant-sync-failures,deployment-versions}
```

最终数字：33 迁移 / 26 个 pgTAP 文件 / 1126 条断言（总览 39 + 报表 28）；
集成 18 文件 352 例；单测 56 文件 717 例；build 主 chunk 1,638.77 kB 无增长
（本域没碰前端）；`deps:audit` critical 0 / high 0 / moderate 1 / low 0；
许可 349 组。13 道门禁全绿。

`o-t13` **没有**改成 done：导出（异步任务 + 签名下载 + 审计）还没动，
`/settings` 与 `/dictionaries` 也还是空的。看板卡上的 desc 记了这两块的状态。

## 关键决策

### 1. 口径统一的落地形态是「只算一次的地方有名字」，不是「大家都不许自己算」

契约 §10 写的是「所有指标、报表、导出必须调用同一组 SQL 视图/函数」。
这句话照字面执行会变成一条禁令，而禁令没有强制力：应收的
`amount - (allocated - reversed)` 在列表、总览、报表、导出里各写一遍，四个
地方都能写对，改口径时漏一处也照样出数。**漏掉 `reversed_amount` 不会报错，
它只会让两个页面的数字差一点点**——最坏的一种缺陷，因为没人会去查两个页面。

所以做法是把三个派生值钉进一个视图 `ops.v_receivable_status`：
`net_amount`、`outstanding_amount`、`status`。总览、应收报表、`list_receivables`
全从它读，改口径只改视图一处。

断言也按这个来写：pgTAP C6–C9 与集成测试都是**逐值相等**，不是「大致相等」。
两个各写一遍的 SQL 只要都对，值也相等——所以相等本身不能证明「只算了一次」，
但它能证明「没有算成两个数」，而后者才是会伤人的那种。

### 2. 无权限的指标不进 `metrics`，进 `restrictedMetrics[]`——键不存在，不是 0

`delivery_ops` 没有 `receivable.read`，`finance_ops` 没有 `tenant.read`。
两张账号的 `/overview` 拿到的指标集合不同，缺席的那些进 `restrictedMetrics`。

0 冒充是最坏的形态：前端拿 `metrics.pendingReceiptAmount === 0` 渲染成
「没有待处理收款」，运营看到的是一个结论，实际是「你看不到」。而「键不存在」
必须被显式处理——`in` 判断写不出来就说不过去。

`restrictedMetrics` 里既装指标名、也装 `amounts` 这个**区块**（整张币种表）。
两者在前端的处理不同：少一格数字 vs 整块换成「无权限查看」。所以契约包里是
一个 union（`OPS_OVERVIEW_RESTRICTED_SECTIONS`），对账常量算指标数时要减掉
区块数，否则「指标数」永远比契约多一。

### 3. `partialFailures[]` 与 `restrictedMetrics[]` 是两个字段

前者是「数据不全，去补」，后者是「无权，去找管理员」。合成一个
`warnings[]` 前端只能猜。当前唯一的 `partialFailures` 是
`RECEIPT_CURRENCY_MIX`：`pendingReceiptAmount` / `unreconciledAmount` 是标量，
只取 CNY（§2.2 的默认币种），而库里存在别的币种的收款时，这两个数字不是
「全部」。**标量金额与按币种分组天然冲突**，说清楚比装作没有好。

### 4. 报表的 `totals` 从明细重算，不由 `rows[]` 相加

分组是展示方式，合计是事实。两者在正常情况下必然相等，所以「从 rows 相加」
看起来是等价的省事写法——直到某个 key 落到 `label` 回退分支、或者某天加了
一个「其他」桶。那时合计会悄悄少一块，而报表看起来完全正常。

### 5. 「同步失败」的定义是「最新一条命令是 failed」，先取最新、再判失败

契约 §10 的原文是「每个映射的最新一条命令」。第一版把 `status = 'failed'`
写在 `distinct on` 之前，取到的是「每个映射最新的那条**失败**命令」：
一个映射失败三次、第四次成功，它会永远留在报表里。这个数字只增不减，
运营看到第三周就开始无视它——报表失去作用的方式通常不是算错，是没人看了。

更糟的是**总览那边写对了**（`where latest.status = 'failed'` 在 CTE 之外），
于是同一时点两个页面给出两个数。这正是 §10 禁止的形态，而且两边都不报错。
现在有 S6 把「报表行数 = 总览 `failedSyncCommands`」写成断言。

### 6. 报表的客户从**映射**取，不从命令行取

`tenant_commands.customer_id` 可空（o-t10 允许只挂合同的命令）。用它 join
客户表，那些命令会让整行静默消失——报表变成空表而不报错。最难查的一种
「看起来没问题」。

### 7. 三个契约没写死、实现必须选一边的默认值

- 应收报表 `groupBy` 缺省 `customer`：默认读者是商务，最常问「哪些客户欠钱」。
  另一个候选「按应收逐行」与 `/receivables` 完全重复，没有存在的理由。
- 临期权益 `subjectType` 缺省「两种都要」：最常问「这个月有什么要到期」。
- 版本分布 `status` 缺省 `active + maintenance`：`planned` 没上线、`retired`
  已下线，混进去是把历史包袱当现状。

写在这里是因为它们会被前端当默认值抄走；散在代码里就变成「实现了但没人知道」。

### 8. `filters_echo` 用 camelCase，`rows`/`totals` 用 snake_case

看着矛盾，其实是两类东西：前者是**请求参数的回声**（`customerId`、
`groupBy`、`dueFrom`），会和契约里的查询参数同名，前端原样回填筛选表单；
后者是**形状函数出的列**，出站由 `protocol.ts` 翻成 camelCase。

## 踩坑

### 断言太松比断言错更难发现

`filters_echo` 的键第一次写成 `group_by`（其余五个都是 camelCase）。pgTAP
当时写的是 `#? 'group_by'`——「有这个键」，于是 SQL 和断言一起错，27 条全绿。
一直漏到集成层，以三个 503（`The report returned an unexpected shape`）暴露。

把 R12 改成整块 `jsonb` 相等之后它才拦得住。**「断言太松」不报错，它只是
允许了一个错**，而一个允许错误的绿勾比没有断言更危险：它让人以为验过了。

### 变异一枪打出一块夹具空洞

把 `totals.overdue_amount` 里的 `outstanding_amount` 换成 `amount`，
pgTAP 全绿。原因不是断言写错，是夹具里那条逾期应收**一分钱都没收过**：
金额 1000、尚欠 1000，两种算法给同一个数。补成「1000 已收 400、尚欠 600」
之后同一枪立刻红。

由此也发现 R8 用 `rows,0` 下标断言——行序是「欠得多的在前」，逾期一旦部分
收回，第一名就换成未来那一桶。改成按 key 定位那一桶：用下标断言的测试会在
夹具一动时就红，但是从错误的原因红。

### 变异第二枪打出真正的逻辑缺陷

就是上面第 5 条。这一枪不是「验证断言有效」，是**发现代码错了**。

### 其余三个旧坑复现

- `z.iso.datetime()` 默认只认 `Z`，SQL 的 `timestamptz` 出 jsonb 是 `+00:00`
  → 整份响应 500。要 `{ offset: true }`。
- PL/pgSQL 里 `arr := arr || 'x'` 是数组字面量拼接，报 `malformed array literal`
  → `array_append`。
- 局部变量与 CTE 同名列 → `column reference is ambiguous`，局部变量统一加
  `filter_` 前缀。

### 一条表落地会让别处的守卫从「跳过」变「真查」

o-t10 收口时把 pgTAP 里两处「等表落地再查」换成了 `deployment_version` 当空域
替身，o-t11 落地后它就真查了。这是同一件事的第二次。**改法不能是「换成下一个
还没落地的类型」**——那只是把炸弹往后传。要造真实记录 + 补正向断言。

## 未验证 / 遗留

1. **导出三个端点全未做**（异步任务、签名下载、`export.read` /
   `export.create` 分离、导出本身要写审计）。`ops.exports` 表还不存在。
2. **`/settings` 与 `/dictionaries` 未做**。表在
   （`20261031000001_ops_settings.sql`），键名白名单只有三个，加第四个键要改迁移
   （见 C-107）。
3. **集成层的「相等」只在数据出现部分核销时才能发现算法分歧**。并行跑在同一个
   库上、没有固定夹具，所以那边只能证明「两个端点读同一份」，证明不了「算法对」。
   算法由 pgTAP 的固定夹具钉（R6 / S6），这条分工写进了测试文件头注释。
4. **C-119 未闭环**（`license_id` 与 `licenses[]` 可能不一致）。临期权益报表
   直接读 `ops.private_licenses` 与 `ops.subscriptions`，不依赖合同快照里的
   `licenses[]`，所以本域不受它影响；但「合同详情里的 licenses[]」与「权益报表」
   这两条读路径仍然可能给出不同答案，等契约裁决。
5. **审计一条没写**：报表与总览是只读域，本来就不写审计，这一条属于
   `o-audit-write`（客户 / catalog / 合同 / billing 四域的写侧）。
