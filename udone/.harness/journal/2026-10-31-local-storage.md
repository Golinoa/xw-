# 本地对象存储替身：让「签名」这件事在本地有语义

2026-10-31 · 提交 `5cc94fd` · 关联 `o-t13`（导出）、`o-t14`、`C-122`

## 一、起点是一个线上必坏的实现

合同附件的签名 URL 一直是这么来的：

```ts
const token = crypto.randomUUID();
url: `${base}/storage/v1/object/sign/ops-contracts/${path}?token=${token}`
```

形状完全正确，所以它过了 8 条单测、2 条集成、和当时的全部门禁。但 Supabase
的签名 URL 是**它自己用 service_role 签的 JWT**，payload 里绑 `url` 与 `exp`。
一个随机 UUID 在它那里一律 400。

也就是说：这段代码在线上没有一条路径能跑通，而本地没有一条断言能发现。区别在于
「本地没有 `/storage/v1`」——不是缺测试，是缺被测对象。

## 二、为什么替身要仿 Supabase 的 HTTP 表面，而不是接 MinIO

MinIO 是 S3 兼容，签名是 presigned query（`X-Amz-Signature` 那套）。它能让本地
传起来，但 URL 形状与 Supabase 不同，于是：

- 本地通过的路径编码规则，线上可能不适用（S3 对 `+`、`~` 的处理与 Supabase 不同）；
- 「换 path 复用 token 失败」在 S3 上成立的方式不同（它绑的是 canonical request）；
- 最要命的是：本地与线上走的是**两套签名语义**，而代码只有一份。

替身仿的是 `/object/sign/`、`/object/upload/sign/`、`/object/` 三类路径，
token 是 HMAC-SHA256 的真 JWT（`{url, iat, exp}`）。这样「过期」「绑定」
「私有」三条在本地是真断言，在线上是同一条语义。

## 三、四条写下来的判断

**1. 网关按前缀路由，不把存储塞进网关进程。**

`/rest/v1` → PostgREST，`/storage/v1` → 存储，其它前缀仍 501。这是 Supabase 的
Kong 在做的事；放在网关里等于「只在测试环境存在的中间件」，通过的用例说不出线上
是否也过。放两个进程还有一个实际好处：转发错上游会立刻 404，而写在同一个进程里
两条路由会安静地走到对方的 handler。

**2. 签名必须问存储要，代价是端点从此依赖外部服务。**

拿不到签名回 503 `STORAGE_UNAVAILABLE`，不是 201 + 一个编出来的地址。回 201 的
后果是元数据已落库（`pending`）、客户端以为可以传、而对象从来没到存储里——这条
路径最后表现为「附件一直停在 pending」，没人会去怀疑那个 URL 是假的。

**3. bucket 必须 private，签名只能由后端发。**

导出可能含全量客户数据。bucket 一旦 public，`REVOKE ALL + RLS 无策略` 那套在
对象存储这一侧全部失效——数据绕过数据库被直接取走。

**4. 两个 bucket，不共用一个。**

`ops-contracts` 跟合同生命周期走，`ops-exports` 跟保留期（90 天）走。混一个，
清删任务会按导出的保留期删掉合同附件。

## 四、冒烟时抓到的两个真缺陷

**① 签发出去的 URL 没有按段编码**

`#` 在 URL 里是 fragment 分隔符。签名接口回一个带原始文件名的路径，客户端
`fetch` 它时后半段被丢掉，上传实际写到一个截断的名字上，**而响应是 200**。
中文与空格同理（空格会被转成 `%20` 或被截）。修法是签发时就按段
`encodeURIComponent`——不是让调用方去编码，因为调用方拿到的是「可直接用的 URL」，
这是签名接口的承诺。

**② `..%2F..%2Fetc` 是一段，不是三段**

穿越检查原先只比 `== '..'`。`split('/')` 切不开 `..%2F..%2Fetc`（它里面没有
字面 `/`），于是它作为一个合法段通过，`decodeURIComponent` 之后才变成
`../../etc`。修法是段内出现 `/` 或 `\` 一律拒绝：一个「段」按定义不含分隔符。

顺带记一条测试上的坑：`%2e%2e` 那条穿越走 HTTP 验不出来——Node 的 fetch 在发
请求前就把 dot-segment 归一化并从路径里吃掉了，服务端只会收到 404。所以那条断言
直接调 `resolveObjectPath` 纯函数，而不是打 HTTP。

## 五、变异三枪

| 变异 | 打红的断言 |
|---|---|
| 把存储签好的 token 换成随机 UUID（旧实现的行为） | 集成 `uploads and downloads the same bytes`：PUT 400 |
| 去掉 `exp` 判断 | 单测 `rejects an expired token` |
| 去掉 `url` claim 比对 | 单测 `binds the token to one object` |

第一枪是这一轮最值钱的一条：它证明新加的那条集成用例确实守着「签名必须由存储
签」这件事。此前所有断言都只看 URL 字符串，而字符串在旧实现里一样对。

第一枪还暴露了一件事：最初那条集成用例只断言 `uploadUrl` 里含
`/storage/v1/object/upload/sign/`。**假签名满足这个条件。** 一条断言如果连它要
防的错误都能通过，它的覆盖率是零——而它看起来像有。

## 六、未验证（需要真 Supabase 项目）

1. `signedURL` 的实际字段名与相对路径前缀。本实现按 `/object/sign/...` 推测，
   线上若是 `/storage/v1/object/sign/...` 或别的键名，`createSignedUrl` 会抛
   `storage response is missing the signed path` 而不是返回坏链接——这是刻意的，
   但要真机确认一次。
2. 上传签名回包里 `url` 与 `token` 两个字段是否都带 token。桩里两个都带了。
3. `expiresIn` 的上限。本实现取 604800（7 天）作上界，Supabase 文档口径一致，
   但返回值边界未实测。
4. 真机跨源下的 cookie（`Secure` + `SameSite=Strict`），与 `o-w04b` 是同一批
   待验证项。

## 七、对 `o-t13` 的影响

导出不再被「存储选型」卡住：`downloadUrl` 用同一个 `createSignedUrl`，
bucket 换 `ops-exports`，本地立刻能端到端跑。剩下的是异步任务宿主——那是
`C-118` 的同一个问题（命令建得出来但没人推进），不是存储问题。
