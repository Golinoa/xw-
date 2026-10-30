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
const HASH = /[0-9a-f]{7,40}/;
const EXEMPT = /无独立提交|证据缺失/;
const UNLOCK = /解锁条件/;

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

if (problems.length > 0) {
  console.error(`board:check 失败 — ${problems.length} 处不一致\n`);
  for (const problem of problems) console.error(`  · ${problem}`);
  console.error(`\n${summary}`);
  process.exit(1);
}

console.log(`board:check 通过 — ${summary}`);
