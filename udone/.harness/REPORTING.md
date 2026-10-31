# Status reporting rules

Applies whenever development status, progress, or completion is reported to the operator. A single factual answer to a narrow question is not a status report and does not need a diagram.

## The diagram is mandatory

- Report status as an inline diagram rendered in the conversation, not as a prose list and not as a file to open. The operator asked to see progress; an artifact they have to download is not compliance.
- One diagram per end of the monorepo. `udone` and `admin` never share a diagram. Shared facts (branch, release manifest, cross-end contracts) belong in the text below the diagrams.
- The diagram follows the current IDE theme: light surfaces with dark text under a light theme, and the reverse under a dark theme. Text must stay readable in both.

## Every item carries one of four states

| State                 | Meaning                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| Delivered, verified   | Committed, and the named gate was actually run and its result observed. |
| Delivered, unverified | Committed, but the gate could not be run in this environment.           |
| In progress           | Uncommitted, or committed but plainly incomplete.                       |
| Not started           | No commit, no code.                                                     |

- Never render an unverified item in the same visual language as a verified one. If the difference lives only in the caption, the diagram is lying.
- Do not invent a completion percentage across a task list that has no agreed weighting. Count items or show states; do not average impressions.
- An empty or scaffolded module is reported as scaffolded. A template that came from upstream is not "progress on our features".

## Numbers come from output observed this session

- Test counts, gate results, migration counts, assertion counts, commit ids, and bundle sizes are read from commands run in the current session. Do not recall them from earlier in the conversation.
- A check that was not run is reported as not run. It is never reported as passing, and it never appears as a green node.
- If one run disagreed with later runs — an intermittent failure — say so, with both counts. Smoothing it into "all green" destroys the only evidence that it happened.
- Known defects that were deliberately left unfixed belong on the diagram as unresolved, not omitted. The operator needs to see the outstanding risk where the progress is shown, not only at the end of a paragraph.

## The task board is the single ledger for work items

The HTML board at `D:/MYC/Coding/XW-ERP/dev-board.html` (outside this repository, not version-controlled) is the authoritative list of work items for both ends. The conversation summarises; the board records.

- **Register before starting.** A task that is not on the board does not get worked on. Adding it means: id, title, one-line description carrying the current evidence, `versionId`, priority, tags.
- **Move the state in the same step.** `todo` → `in_progress` when the first line of code is written, `done` only after the commit exists and the named gate was actually run. On `done`, put the commit hash and the measured numbers into `desc`.
- **Bump `SEED_VERSION` with every edit.** The board keeps a copy in `localStorage` and only replaces it when the seeded version is newer. Editing the seed without bumping the version means the operator keeps looking at stale data while the file looks correct.
- **Do not invent dates.** Tasks without a committed schedule keep empty `start`/`end`; the Gantt is not a forecast.
- **Blocked is a state, not a footnote.** Use `blocked` and write the unlocking condition in `desc`, so the dependency is visible where the status is.

A "done" claim in the conversation that the board does not show is a reporting defect; fix the board first, then speak.

## Completion is a two-part act

完成为「两半」：代码落库（提交存在）+ 看板同步。只有其一，一律按未完成处理。这条不是流程建议，是判定标准——判断一项工作是否完成时看这两个条件，不看聊天里说过什么。

- **同一次编辑里移状态。** 不允许「先写代码，回头补看板」：回头补的那次一定会漏，而漏掉的那张卡在下次汇总时会以「未完成」出现，等于白干一遍，或者反过来被当成已完成而从未验证。
- **一个提交可以关多张卡，但每张卡都要写清是哪一次提交。** 写「已完成」不算证据；写 `cf8c265 + 517e297` 才算。同一次纵切提交承载多张卡时如实并列，不要为了好看拆成假哈希。
- **确实没有独立提交的要写明原因，而不是空着。** 例如「初始合并 8ccd36e，审计结论在 journal 内，无独立提交」——豁免标记是 `无独立提交` 或 `证据缺失`，机械检查认这两个词。
- **状态只向前。** `todo` → `doing` → `done`；回退必须在该卡 `desc` 里写原因（例如「原以为交付，复核发现断言是替身」），否则下一个人只会看到状态莫名其妙地倒退。
- **未完成不许有 `end`。** 有开始日期可以，有结束日期就等于对外承诺。
- **`blocked` 必须带 `解锁条件：` 四个字。** 只描述「现在是阻塞的」没有用，读的人要知道做完什么它才会解除。

## The board has a mechanical check

```
pnpm board:check     # 读 ../../../XW-ERP/dev-board.html，可用 BOARD_PATH 覆盖
```

它校验九件事：`SEED_VERSION` 与 `seed.seedVersion` 一致；卡片 id 唯一；`versionId` 引用存在；`done` 有 `start`、`progress=100` 且 `desc` 能指回提交或写明豁免；**`done` 卡与已闭环协作项引用的提交哈希必须能在仓库对象库里解析成 commit**（至少一条可达，全是悬空才红；没有 git 时整项跳过）；非 `done` 没有 `end`、`progress` 不到 100；`blocked` 写了 `解锁条件`；协作项五个文本字段非空且 `blocks` 指向真实卡、不阻塞已 done 的卡；卡片与协作文本不得用第一人称。

哈希形状是短哈希 7–12 位、完整 40 位，**不是 7–40**：迁移文件名开头是 14 位纯数字时间戳（`20261030000003`），`{7,40}` 会把它当成哈希，于是「只提一句迁移编号」就能冒充证据。

第九条（可达性）的理由：此前只校验证据「长得像」，不校验「查得到」。`a-import` 记的 `63a38dc` 属于合并前三仓时代，`8ccd36e` 合并成单仓时没保留旧历史，对象库里没有这个 commit——卡片 done、检查绿，任何人照着哈希核对都在第一步失败。形似证据比没有证据更糟：没有会让人去补，形似会让人以为核过了。判据取「至少一条可达」而非「全部可达」，是因为卡片需要留一句「原哈希属合并前仓库、现不可达」，要求全部可达等于逼人删掉这句说明。

看板在仓库外、CI 看不到它，所以脚本在文件缺失时打印 `skipped` 并返回 0——**本地跑绿是义务，CI 里跳过不是豁免**。检查失败时的处置是改看板，不是改脚本：这条命令存在的意义就是把「看板可信」变成可执行的东西，放宽它等于取消它。

第一次跑这条命令就抓出两张 `blocked` 卡没写解锁条件（`a-integrate`、`a-accept`）——两个都是我自己写的卡。规则不机械执行时，最先违反的总是写规则的人。

## Items waiting on the other end

Anything blocked on the ops side is reported from the board's `COLLAB` list, not from memory and not from prose in the report. Rules in [`COLLABORATION.md`](COLLABORATION.md).

- Give each item its own state: waiting on the ops side, answered and awaiting the business side, closed with a locator. A blanket "still waiting" is not a state report.
- An item is closed only when the evidence can be located — a commit hash, a contract section, or a line number. A closed item whose evidence cannot be located is worse than an open one, because nobody goes back to check it.
- When a milestone is reported, every `COLLAB` item whose `due` falls in that milestone gets its own line. The reader is deciding whether to chase someone; that decision needs per-item facts.

## Naming the two ends

Both sides read these documents, and both sides write into them. First person has no stable referent here: 「我方做不了」, read by the ops side, means the ops side cannot do it — the reference inverts on the reader, who then acts as the wrong party.

- Only「业务端」(this repository, `feat/business-slice`) and「运营端」(the adjacent worktree, `feat/ops-console`). Never 我 / 我们 / 我方 / 我这侧 / 对方 / 他们.
- 「对方」 does a second kind of damage: it turns an engineering disagreement into a personal one. 「运营端未回写契约 §5.1」 can be checked. 「他们还没理我们」 cannot.
- `pnpm board:check` rejects those seven forms in card titles, card descriptions, every `COLLAB` field, and the `BLOCKERS` array. Definition, reasoning, and the check itself: [`COLLABORATION.md`](COLLABORATION.md) §0.

## Prohibited

- A status report with text only, when the report has more than one work item.
- A single diagram covering both ends.
- An unverified item styled as complete.
- A percentage not computed from counted, equal-weight items.
- Deck-style imagery: gradients, shadows, decorative icons, or any element that exists to look impressive rather than to carry a state.

The text that accompanies the diagram follows the handoff rules in [`../AGENTS.md`](../AGENTS.md): changed files, actual validation, remaining uncertainty, next steps. Diagram and text are complementary — the diagram carries state, the text carries reason and risk. Neither replaces the other.
