#!/usr/bin/env node
/**
 * 看板一致性检查（.harness/REPORTING.md「任务完成是两半」的机械部分）。
 *
 * 为什么需要它：看板在仓库外、不进版本控制，没有任何门禁能拦住「代码写了、
 * 看板没动」。而看板的唯一价值就是「它说的话可信」——一旦允许一张 done 卡片
 * 指不出提交，整块看板的数字就都不能用了。所以把「done 必须有证据」变成一条
 * 可执行命令，而不是一句自觉。
 *
 * 检查项：
 *   1. SEED_VERSION 是正整数（改了内容不升版本，浏览器旧 localStorage 会盖掉新数据）
 *   2. 卡片 id 唯一
 *   3. 每张卡有 id / title / status / versionId，且 versionId 在 versions 里存在
 *   4. done 必须有 start、progress=100，且 desc 里能指回提交（7 位十六进制）
 *      或显式写明「无独立提交」「证据缺失」——后者是有意的例外，不是漏洞
 *   5. 非 done 不得有 end（不把估算当排期），progress 不得为 100
 *   6. blocked 必须在 desc 里写解锁条件（关键词：解锁 / 阻塞条件）
 *   7. 协作事项（COLLAB）必须：id 唯一、状态与类型合法、need 写清具体动作、
 *      blocks 指向真实任务卡、closed 必须有证据
 *   8. 看板文字只能用「业务端」「运营端」指代两端，不得用第一人称或泛指
 *
 * 第 7 项的理由：协作页是跨端「谁在等谁」的唯一真源。它一旦失准，比没有更糟——
 * 人会照着过期的 waiting 去催一件对方早就做完的事，或者以为已闭环而实际没做。
 * 所以「closed 要证据」「need 不许写空话」都得由命令来拦，不能靠自觉。
 *
 * 第 8 项的理由：这块看板两端都在看，两端也都会改。写「我这边做不了」时，读的人
 * 分不清这个「我」是业务端还是运营端——指代正好读反的成本，是照着错的角色去干活。
 * 术语口径见 .harness/COLLABORATION.md §0。
 *
 * 看板路径：默认 ../../../XW-ERP/dev-board.html（相对本文件），可用 BOARD_PATH 覆盖。
 * 文件不存在时按「跳过」处理并返回 0——看板在仓库外，CI 看不到它是正常情况，
 * 不能因此让流水线红。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const boardPath = process.env.BOARD_PATH
  ? path.resolve(process.env.BOARD_PATH)
  : path.resolve(here, '../../../XW-ERP/dev-board.html');

if (!fs.existsSync(boardPath)) {
  console.log(`board:check skipped — 没找到看板（${boardPath}）`);
  process.exit(0);
}

const html = fs.readFileSync(boardPath, 'utf8');
const problems = [];
const fail = (message) => problems.push(message);

const versionMatch = html.match(/^const SEED_VERSION = (\d+);$/m);
if (!versionMatch) fail('SEED_VERSION 未声明或不是整数');
const seedVersion = versionMatch ? Number(versionMatch[1]) : 0;

const seedMatch = html.match(/const seed = \{[\s\S]*?\n\};/);
if (!seedMatch) {
  console.error('board:check 失败 — 解析不到 seed 对象');
  process.exit(1);
}

const sandbox = { SEED_VERSION: seedVersion };
vm.createContext(sandbox);
try {
  vm.runInContext(`var seed;${seedMatch[0].replace('const seed', 'seed')}`, sandbox, {
    timeout: 5000,
  });
} catch (error) {
  console.error(`board:check 失败 — seed 求值出错：${error.message}`);
  process.exit(1);
}

const { tasks, versions } = sandbox.seed ?? {};
if (!Array.isArray(tasks) || !Array.isArray(versions)) {
  console.error('board:check 失败 — seed.tasks 或 seed.versions 不是数组');
  process.exit(1);
}

const versionIds = new Set(versions.map((version) => version.id));
const seen = new Set();
const counts = { done: 0, todo: 0, doing: 0, blocked: 0 };
// 提交哈希与迁移文件名的时间戳前缀共用十六进制字符集，区别只在长度段：项目里的
// 短哈希是 7 位（看板现有 23 处证据全部落在 7–8 位），完整哈希 40 位；而迁移文件名
// 开头是 14 位纯数字（YYYYMMDDHHMMSS，例如 20261030000002）。
//
// 旧版写 {7,40}，于是「20261030000002」这种日期前缀被当成了短哈希：一张 done 卡只
// 要在 desc 里提一句迁移编号，「指不出提交」就通过了；一条 closed 的协作项只写
// 「看迁移文件 20261030000002」，「证据定位不了」也通过了——而这两处都定位不到任何
// 提交或任何一行。变异实测：把 C-95 的证据换成只剩那串数字，旧版绿、新版红。
const HASH_SHAPE = '\\b(?:[0-9a-f]{7,12}|[0-9a-f]{40})\\b';
const HASH = new RegExp(HASH_SHAPE);
const EXEMPT = /无独立提交|证据缺失/;
const UNLOCK = /解锁条件/;
const LOCATOR = new RegExp(`${HASH_SHAPE}|§\\s*\\d|第\\s*\\d+\\s*行|\\bL\\d+`);

// 两端共用一个看板，第一人称在这里没有唯一指代：读的人容易把「我」读成自己，
// 而「对方」把工程分歧写成了私人往来。只认「业务端」「运营端」。
// 「自我」「其他」是正常词，用后视排除。
const BANNED = /我们|我方|我这侧|对方|他们|对端|(?<!其)(?<!自)我(?!们)/;
const bannedIn = (value) => {
  // 压平换行，否则报错片段会从上一行的括号开始，看不出问题在哪。
  const text = String(value ?? '').replace(/\s+/g, ' ');
  const hit = text.match(BANNED);
  return hit ? text.slice(Math.max(0, hit.index - 10), hit.index + 14).trim() : null;
};

if (sandbox.seed.seedVersion !== seedVersion) {
  fail(`seed.seedVersion(${sandbox.seed.seedVersion}) 与 SEED_VERSION(${seedVersion}) 不一致`);
}

for (const task of tasks) {
  const where = task.id || task.title || '(无 id 的卡)';

  if (!task.id) fail(`${where}: 缺 id`);
  if (!task.title) fail(`${where}: 缺 title`);
  if (!task.versionId) fail(`${where}: 缺 versionId`);
  else if (!versionIds.has(task.versionId)) fail(`${where}: versionId ${task.versionId} 不存在`);

  if (seen.has(task.id)) fail(`${where}: id 重复`);
  seen.add(task.id);

  for (const [field, value] of [
    ['title', task.title],
    ['desc', task.desc],
  ]) {
    const hit = bannedIn(value);
    if (hit) fail(`${where}: ${field} 用了第一人称/泛指（「…${hit}…」改用「业务端」或「运营端」）`);
  }

  if (!(task.status in counts)) {
    fail(`${where}: 未知状态 ${task.status}`);
    continue;
  }
  counts[task.status]++;

  if (task.status === 'done') {
    if (!task.start) fail(`${where}: done 但没写 start`);
    if (task.progress !== 100) fail(`${where}: done 但 progress=${task.progress}`);
    if (!HASH.test(task.desc) && !EXEMPT.test(task.desc)) {
      fail(`${where}: done 但 desc 指不出提交（也没有写「无独立提交」）`);
    }
  } else {
    if (task.end) fail(`${where}: 未完成却写了 end（不把估算当排期）`);
    if (task.progress === 100) fail(`${where}: 未完成却 progress=100`);
    if (task.status === 'blocked' && !UNLOCK.test(task.desc)) {
      fail(`${where}: blocked 但没写解锁条件`);
    }
  }
}

const summary = `看板 ${path.basename(boardPath)} · SEED_VERSION ${seedVersion} · ${tasks.length} 张卡（${counts.done} done / ${counts.doing} doing / ${counts.todo} todo / ${counts.blocked} blocked）`;

/* ── 协作事项 ── */
const collabMatch = html.match(/const COLLAB = \[[\s\S]*?\n\];/);
let collabNote = '';
if (!collabMatch) {
  fail('解析不到 COLLAB 常量（双端协作页的数据源）');
} else {
  const collabSandbox = {};
  vm.createContext(collabSandbox);
  try {
    vm.runInContext(
      `var COLLAB;${collabMatch[0].replace('const COLLAB', 'COLLAB')}`,
      collabSandbox,
      { timeout: 5000 },
    );
  } catch (error) {
    console.error(`board:check 失败 — COLLAB 求值出错：${error.message}`);
    process.exit(1);
  }

  const collab = collabSandbox.COLLAB;
  if (!Array.isArray(collab)) {
    fail('COLLAB 不是数组');
  } else {
    const TASK_IDS = new Set(tasks.map((t) => t.id));
    const DONE_IDS = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
    const STATUSES = new Set(['blocking', 'waiting', 'answered', 'closed']);
    const TYPES = new Set(['裁决', '确认', '验证', '回写']);
    const EMPTY_NEED = /^(沟通|对齐|同步|看一下|留意)/;
    const seenCollab = new Set();

    for (const c of collab) {
      const at = c.id || c.title || '(无 id 的协作项)';

      if (!c.id) fail(`协作 ${at}: 缺 id`);
      if (!c.title) fail(`协作 ${at}: 缺 title`);
      if (!c.impact) fail(`协作 ${at}: 缺 impact（说不出影响的事不该登记）`);
      if (!c.need) fail(`协作 ${at}: 缺 need（没写要对方做什么）`);
      if (!c.due) fail(`协作 ${at}: 缺 due（何时需要，否则不知道急不急）`);
      if (!c.evidence) fail(`协作 ${at}: 缺 evidence（依据，否则无从复核）`);

      if (seenCollab.has(c.id)) fail(`协作 ${at}: id 重复`);
      seenCollab.add(c.id);

      for (const field of ['title', 'impact', 'need', 'due', 'evidence']) {
        const hit = bannedIn(c[field]);
        if (hit) {
          fail(`协作 ${at}: ${field} 用了第一人称/泛指（「…${hit}…」改用「业务端」或「运营端」）`);
        }
      }

      if (!STATUSES.has(c.status)) fail(`协作 ${at}: 未知状态 ${c.status}`);
      if (!TYPES.has(c.type)) fail(`协作 ${at}: 未知类型 ${c.type}`);

      if (c.status !== 'closed' && EMPTY_NEED.test(String(c.need || '').trim())) {
        fail(`协作 ${at}: need 是空话（以「沟通/对齐/同步」开头），要写成可照做的动作`);
      }

      for (const id of c.blocks || []) {
        if (!TASK_IDS.has(id)) fail(`协作 ${at}: blocks 指向不存在的任务 ${id}`);
        else if (c.status !== 'closed' && DONE_IDS.has(id)) {
          fail(`协作 ${at}: 尚未闭环，却阻塞一张已 done 的卡 ${id}（状态自相矛盾）`);
        }
      }

      // 「闭环要有证据」必须能定位：提交哈希、契约章节号、或具体行号。
      // 第一版这里写的是 /已/，结果任何中文句子都能过 —— 变异测试当场把它打穿。
      if (c.status === 'closed' && !LOCATOR.test(String(c.evidence))) {
        fail(`协作 ${at}: closed 但证据定位不了（要提交哈希、§章节号 或 行号）`);
      }
    }

    const openCount = collab.filter((c) => c.status !== 'closed').length;
    collabNote = ` · 协作 ${collab.length} 项（${openCount} 未闭环 / ${collab.length - openCount} 已闭环）`;
  }
}

/* ── 阻塞清单 ── */
const blockersMatch = html.match(/const BLOCKERS = \[[\s\S]*?\n\];/);
if (blockersMatch) {
  const hit = bannedIn(blockersMatch[0]);
  if (hit) fail(`BLOCKERS: 用了第一人称/泛指（「…${hit}…」改用「业务端」或「运营端」）`);
}

if (problems.length > 0) {
  console.error(`board:check 失败 — ${problems.length} 处不一致\n`);
  for (const problem of problems) console.error(`  · ${problem}`);
  console.error(`\n${summary}${collabNote}`);
  process.exit(1);
}

console.log(`board:check 通过 — ${summary}${collabNote}`);
