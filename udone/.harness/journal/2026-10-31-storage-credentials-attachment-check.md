# 存储凭据与附件完成校验（2026-10-31 18:20 起）

这一轮不打新功能。用户说「先修复再推进」，于是先做一次针对性的缺陷排查，把
「已经写错、但本地全绿」的地方找出来。结论是**两处，同一个形态**：

> 本地缺少线上会拒绝的约束，而缺的那一条恰好就是被测的那一条。

上一轮的「随机 UUID 当签名」是第一次出现，这一轮又找到两次。这条模式值得
单独记下来：**本地替身比线上宽松时，它保护的就不是「线上会怎样」而是「本地
能过」**。

---

## 一、签名请求一个凭据都不带

`createSignedUrl` 发出的请求只有 `Content-Type`。Supabase 的
`/object/sign/` 在 Kong 之后要求 service_role，未带一律 401。

它比「随机 UUID」更隐蔽：URL 形状完全正确，本地替身也不鉴权，14 条断言全绿。
上一轮修了 token 的**真伪**，没修请求的**身份**——两者是同一件事的两半。

### 修法是两端同时收紧

只改一边没有意义：

- 只改 API：本地替身仍不校验，下次有人再漏掉凭据，本地还是绿。
- 只改替身：API 不发凭据，本地立刻全红，但那是「把测试改红」不是「把代码改对」。

所以：

| 位置 | 改动 |
|---|---|
| `sign.ts` | 请求带 `Authorization: Bearer <service_role>` + `apikey` |
| `local-storage.mjs` | 签发端点要求「签得过且 `role === 'service_role'` 的 JWT」，先判 `apikey` 再判 token |

### 三个判断

**1. 替身认 `role`，不认固定字符串。**

第一版我写的是「`Authorization` 必须等于 `Bearer <某个固定串>`」。它工作，
但多了一条线上不存在的约束：夹具自己签一个 service 令牌就会失败，而真机上
那样做是对的。改成校验 JWT 的 `role` claim 之后，本地与线上是同一个判据。

**2. `apikey` 也要，而且先判。**

Supabase 的网关先校验 `apikey`，再看 `Authorization`。只带其中一个的请求在
真机上被拦在网关，错误同样是 401——看不出少的是哪个。本地照同一个顺序拦，
这条差异才不会留到真机。

**3. 缺配置时直接抛，不发请求。**

```ts
if (typeof serviceKey !== 'string' || serviceKey === '') {
  throw new StorageSignError(
    'storage credentials are not configured (SUPABASE_SERVICE_ROLE_KEY is empty)',
    { bucket, key: objectKey },
  );
}
```

发出去只会得到 `storage answered 401`，而那句话让人去查桶和策略。真正缺的
是一个环境变量，就该说这个。

### 一个中途踩到的坑

给本地栈注入 `SUPABASE_SERVICE_ROLE_KEY` 之后，**41 个写端点全部 500**。

原因：幂等中间件看到这个变量就去调 PostgREST，而我注入的是一个普通字符串
（不是 JWT），PostgREST 用 `JWT_SECRET` 验签失败 → 401 → 500。

也就是说：**本地从来没有跑过幂等中间件的服务端路径**——它一直被
「`SUPABASE_SERVICE_ROLE_KEY` 没配 → 退回内存 store」这条降级分支罩着。

最后没有注入（夹具本来就有 `signServiceToken()`，签的就是 `role:
service_role` 的 JWT），但这个发现值得记：一个「配置存在与否」决定的分支，
在没有配置的环境里永远不会被执行，而它的失败方式是 500。

---

## 二、`complete` 拿「状态不是 pending」冒充「文件没上传」

原来的判定：

```sql
if target.status <> 'pending' then
  return jsonb_build_object('status', 'attachment_not_uploaded');
end if;
```

它同时错了两件事。

**语义错**：`attachment_not_uploaded` 说的是「文件还没传上来」，而这个分支
在「已经 stored」时触发。一个**已经存储、还能正常下载**的附件，重复 confirm
一次会被告知「从未上传过」。

**该查的没查**：真正的「没上传」是「存储里没有这个对象」，而这段代码只看
数据库那一行的状态。那一行在 `create` 时就写了，所以 `complete` 一个从未
上传过的附件**永远成功**：状态变 `stored`，列表里显示正常，点下载才 404。

### 根因是「数据库不知道 Storage」，而这个理由现在不成立了

函数里原来的注释写着「不查 Storage（本地无 Storage，U-13）」。上一轮把本地
存储搭起来之后，这句话就不成立了——但代码没跟着变。**环境变了、注释与实现
没跟上**，是比「写错」更难发现的一类：它看起来仍然有理有据。

### 改法：先读、再核、后改

新增只读函数 `ops.contract_attachment_location(p_attachment_id)`：

- 权限与 `complete` 同为 `contract.write`（不借 `contract.read`：能确认上传的
  人不一定能读合同正文）；
- 返回 `storage_path`、`file_name`、`byte_size`、以及**行当前状态**（调用方
  一次拿到，不用为判断幂等再查一遍）。

API 流程变成：

```
location（拿路径） → HEAD 对象 → 不存在就 409 → 存在才 complete
```

**顺序不能反。** 先 complete 再校验，一次失败的校验会留下一行 `stored` 而
存储里没有文件——那个状态比拒绝更糟，因为它在列表里完全正常，只有点下载才
暴露。

### 重复调用改成幂等

已经 `stored` 时返回 `ok` + 当前附件，不写第二行审计、不动
`uploaded_at` / `version`：重试没有产生新的上传，把它记成一次新动作会让
「这个附件何时被上传」的答案随请求次数漂移。

这里有个取舍：也可以回 409。选 200 的理由是——**当请求本身完全正确、结果与
期望一致时，回错误会让客户端把「已经成功」当成「需要人工处理」**。真正的
409 留给对象缺失。

### 顺带拆开一个词

`checksumSha256` 格式错原来也回 `attachment_not_uploaded`。两件事共用一个词
之后，客户端无法区分「检查你的请求体」与「先把文件传上来」，只能笼统提示。
拆成 `invalid_checksum` + `field`，前端可以标红到具体输入框。

---

## 三、四件顺手修的小事

1. **URL 拼接不幂等**。原先是 `${base}/storage/v1${relative}` 一个模板串，
   三种回法里只有一种对：
   - `/object/sign/...`（Supabase 实际回的）✓
   - `object/sign/...`（少前导斜杠）→ 拼成 `storage/v1object/...`，浏览器
     当成端口号后面的一整段路径，回 404
   - `/storage/v1/object/sign/...`（前面挂过反向代理）→ 前缀重复

   后两种「只有真机才会遇到」，本地替身永远回第一种。与其等核对，不如把
   三种都接住——多一个分支的代价远小于上线后逐个端点排查。

2. **`signedURL` / `signedUrl` 两个键名都认**。只认一个的后果不是「拿不到」，
   而是拼出 `...?token=undefined` 这种看起来正常的坏链接。仍然先取再验类型，
   验不过一律抛。

3. **404 的 message 点出 bucket 名**。漏建 `ops-exports` 时，原话是
   `storage answered 404`，让人去查对象路径；现在说的是哪个桶找不到。

4. **两个签名函数的 bucket 参数化**。`STORAGE_BUCKETS.exports` 定义了却没人
   用——两个函数都把 bucket 写死成 `ops-contracts`。写死的后果不是报错，是
   导出文件被签进合同桶，而两个桶的保留期不同。

---

## 四、`sign.ts` 此前一条单测都没有

它只在合同路由测试里被顺带走过，而那条路径只喂一种输入。于是「base 没配」
「存储回绝对地址」「回包缺字段」「bucket 传参」这些分支从来没有被单独执行过，
对不对取决于有没有人碰巧踩到。

新增 14 例，其中两条是这次才有的边界：

- **缺 key 时不发请求**（用 `fetchMock` 断言 `not.toHaveBeenCalled()`）；
- **bucket 参数不被忽略**（断言 URL 里出现 `ops-exports`）。

---

## 五、变异验证

每枪先复原。

| 改坏什么 | 谁红了 |
|---|---|
| 签发请求去掉凭据 | 集成 7 条（附件全部 503） |
| `joinStorageUrl` 退回单模板串 | 2 条（少斜杠 / 已带前缀） |
| 只认 `signedURL` | 1 条 |
| bucket 写死 contracts | 1 条 |
| `object === null` 加 `&& false` | 集成「未上传回 409」 |
| 去掉 SQL 的 stored 幂等分支 | pgTAP「a repeated complete leaves version alone」 |

**两条旧断言改的是错误行为**：`a malformed checksum` 原本期望
`attachment_not_uploaded`，`completing an already stored` 原本期望被拒绝。
它们与实现对错在一起，所以一直是绿的——这是「断言太松」之外的另一种：
**断言忠实地记录了一个错误决定**。

---

## 六、门禁

format / format:sql（63 文件）/ lint / schema:check（35 迁移）/ check:deploy /
deps:audit（critical 0 high 0 moderate 1）/ licenses（349 组）/ typecheck /
test（59 文件 764 例）/ build（主 chunk 1,638.77 kB 无增长）/
db:local:verify（27 文件 1157 断言）/ db:local:http（19 文件 367 例）。

---

## 七、未验证 / 待裁决

1. **`complete` 的重复调用语义契约没写**。§5.4 第 13 条只有「404、409
   `STATE_CONFLICT`（未上传）」一行。实现选了幂等 200，`invalid_checksum`
   映射成 400 + `reason`，两者都不在契约里。要回填。
2. **`byteSize` 未与存储里的实际大小比对**。`headStorageObject` 已经拿到
   `Content-Length`，但只用了「存在与否」。要不要在校验和不一致时也拒？
   现在没做——`byteSize` 是前端报的，与存储的真实大小不符时应当拒绝，否则
   列表里的体积可以是假的。下一轮补。
3. **C-122 的其余三处仍需真机**：上传签名回包是否同时给 `url` 与 `token`、
   `expiresIn` 上界 604800、跨源 cookie 的 Secure + SameSite=Strict。
4. **本地没有 storage policy**。替身的直读接受任意验得过的用户 JWT，线上
   会被 RLS 拒。这是刻意让替身不比线上更严，但也意味着「用户令牌能不能
   直读」这条在本地无法断言。
