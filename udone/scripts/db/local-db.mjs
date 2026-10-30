// 本地 PostgreSQL 测试环境：初始化、启动、重放迁移、跑 pgTAP。
//
// 为什么需要它：这台机器没有 Docker（WSL 被安全策略拦截），`supabase start`
// 跑不起来，于是 `pnpm db:test` 一直是「从未执行」。但项目迁移只依赖
// auth.uid()/auth.jwt() 与三个角色，用原生 PostgreSQL 加一层兼容层就能真正
// 执行 DDL 与 RLS 策略，拿到的是真结果而不是格式检查。
//
// 一切文件都在仓库外（$HOME/.udone-local-pg），不污染工作区。
//
// 关于进程管理：不要用 `pg_ctl start`。它会把 postgres 派生为脱离终端的进程，
// 这个 shell 收尾时连同兄弟进程一起被杀，表现是「日志显示 ready，随后连接被拒」。
// 这里改为把 postgres 作为本进程的直接子进程，收尾时显式优雅停止。
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WORK_DIR = process.env.UDONE_LOCAL_PG_HOME ?? join(homedir(), '.udone-local-pg');
const DATA_DIR = join(WORK_DIR, 'data');
const DOWNLOAD_DIR = join(WORK_DIR, 'downloads');
const LOG_FILE = join(WORK_DIR, 'postgres.log');
const PGTAP_SQL = join(WORK_DIR, 'pgtap.sql');
const PORT = process.env.UDONE_LOCAL_PG_PORT ?? '55432';
const DB_NAME = 'udone_local';
const PG_ZIP_URL =
  'https://get.enterprisedb.com/postgresql/postgresql-17.6-1-windows-x64-binaries.zip';

// PostgREST 是「服务层对 Supabase 的假设」唯一能被真实执行的地方：
// 参数名、返回列名、SQLSTATE 到 HTTP 状态码的映射，都只有经过它才成立。
// 本机没有 Docker / Supabase CLI，所以直接用官方单文件二进制连原生 PostgreSQL。
const REST_PORT = process.env.UDONE_LOCAL_REST_PORT ?? '55433';
const JWT_SECRET = process.env.UDONE_LOCAL_JWT_SECRET ?? 'udone-local-integration-jwt-secret';
const POSTGREST_DIR = join(WORK_DIR, 'postgrest');
const POSTGREST_BIN = join(POSTGREST_DIR, 'postgrest.exe');
const POSTGREST_CONFIG = join(WORK_DIR, 'postgrest.conf');
const POSTGREST_LOG = join(WORK_DIR, 'postgrest.log');
const FIXTURE_SQL = join(WORK_DIR, 'integration-fixture.sql');

// 固定 UUID：集成测试要拿它们签 JWT、拼 X-Organization-ID，
// 随机生成再回传会多一条「把 id 传错」的失败路径，而那与要验证的东西无关。
const ORG_ID = 'a0000000-0000-4000-8000-000000000001';
const USER_IDS = {
  admin: 'a1000000-0000-4000-8000-000000000001',
  operator: 'a1000000-0000-4000-8000-000000000002',
  finance: 'a1000000-0000-4000-8000-000000000003',
};

// 运营端夹具：一个平台管理员。与三个租户账号刻意不重叠——「同一个 auth.users
// 能不能既是租户成员又是运营成员」是另一条待验证的边界，不放进基础夹具里
// 混着测，否则一旦失败分不清是哪一边。
const OPS_USER_ID = 'a1000000-0000-4000-8000-0000000000f1';
const OPS_OPERATOR_ID = 'a2000000-0000-4000-8000-000000000001';

let serverProcess = null;
let postgrestProcess = null;
let gatewayServer = null;

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** 找到 psql/initdb 所在目录：显式配置优先，其次是本脚本下载的位置，最后是系统安装。 */
function findPgBin() {
  const candidates = [
    process.env.UDONE_PG_BIN,
    join(WORK_DIR, 'pgsql', 'bin'),
    'C:/Program Files/PostgreSQL/17/bin',
    'C:/Program Files/PostgreSQL/16/bin',
    '/usr/lib/postgresql/17/bin',
    '/usr/local/pgsql/bin',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'psql.exe')) || existsSync(join(candidate, 'psql'))) {
      return candidate;
    }
  }
  return null;
}

function requirePgBin() {
  const bin = findPgBin();
  if (!bin) throw new Error('未找到 PostgreSQL，先运行：node scripts/db/local-db.mjs setup');
  return bin;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function must(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} 失败（exit ${result.status}）\n${detail}`);
  }
  return result;
}

function extractZip(archive, destination) {
  // Windows 自带的 bsdtar 与 Git 自带的 unzip 都能处理 zip；按可用性依次尝试。
  for (const [command, args] of [
    ['unzip', ['-o', '-q', archive, '-d', destination]],
    ['tar', ['-xf', archive, '-C', destination]],
  ]) {
    if (run(command, args).status === 0) return;
  }
  throw new Error(`无法解压 ${archive}：请手动解压到 ${destination}`);
}

async function download(url, destination) {
  if (existsSync(destination)) return;
  console.log(`下载 ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createWriteStream(destination);
    Readable.fromWeb(response.body).pipe(stream);
    stream.on('finish', resolvePromise);
    stream.on('error', rejectPromise);
  });
}

async function setup() {
  mkdirSync(DOWNLOAD_DIR, { recursive: true });

  if (findPgBin()) {
    console.log(`已找到 PostgreSQL：${findPgBin()}`);
  } else if (process.platform === 'win32') {
    const archive = join(DOWNLOAD_DIR, 'pgsql-win64.zip');
    await download(PG_ZIP_URL, archive);
    console.log('解压 PostgreSQL…');
    // 官方 zip 内层就是 pgsql/，直接解到 WORK_DIR 才会落在 findPgBin 期望的位置。
    extractZip(archive, WORK_DIR);
    console.log(`PostgreSQL 已就绪：${findPgBin()}`);
  } else {
    throw new Error('未找到 PostgreSQL，请用系统包管理器安装后设置 UDONE_PG_BIN');
  }

  if (existsSync(PGTAP_SQL)) {
    console.log('pgTAP 已就绪');
    return;
  }

  // pgTAP 1.x 是纯 SQL，没有 C 扩展，因此不需要编译：
  // 官方 Makefile 也只是把两个占位符替换掉，这里等价地做同一件事。
  const archive = join(DOWNLOAD_DIR, 'pgtap.zip');
  const source = join(DOWNLOAD_DIR, 'pgtap-src');
  await download(
    'https://github.com/theory/pgtap/releases/download/v1.3.3/pgtap-1.3.3.zip',
    archive,
  );
  extractZip(archive, source);
  const template = join(source, 'pgTAP-1.3.3', 'sql', 'pgtap.sql.in');
  const generated = readFileSync(template, 'utf8')
    .replaceAll("'__OS__'", `'${process.platform}'`)
    .replaceAll('__VERSION__', '170000');
  writeFileSync(PGTAP_SQL, generated, 'utf8');
  console.log('pgTAP 已就绪');
}

function psql(database, args) {
  const bin = requirePgBin();
  return run(join(bin, 'psql'), [
    '-X',
    '-q',
    '-h',
    '127.0.0.1',
    '-p',
    PORT,
    '-U',
    'postgres',
    '-d',
    database,
    ...args,
  ]);
}

function psqlMust(database, args) {
  const result = psql(database, args);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`psql 失败（exit ${result.status}）\n${detail}`);
  }
  return result;
}

function isRunning() {
  const bin = requirePgBin();
  return run(join(bin, 'pg_ctl'), ['-D', DATA_DIR, 'status']).status === 0;
}

function initCluster() {
  const bin = requirePgBin();
  if (existsSync(join(DATA_DIR, 'PG_VERSION'))) return;
  mkdirSync(WORK_DIR, { recursive: true });
  console.log('初始化数据目录（仅首次）…');
  // -A trust 只监听回环地址，本地一次性测试库不需要口令；
  // --locale=C 让排序与文本比较行为可预测，不受系统区域设置影响。
  must(join(bin, 'initdb'), [
    '-D',
    DATA_DIR,
    '-U',
    'postgres',
    '-A',
    'trust',
    '-E',
    'UTF8',
    '--locale=C',
  ]);
}

async function waitForReady(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error(`PostgreSQL 启动后退出了（exit ${serverProcess.exitCode}），见 ${LOG_FILE}`);
    }
    if (psql('postgres', ['-t', '-A', '-c', 'select 1']).stdout.trim() === '1') return;
    await sleep(300);
  }
  throw new Error(`等待 PostgreSQL 就绪超时，见 ${LOG_FILE}`);
}

async function start() {
  const bin = requirePgBin();
  initCluster();
  if (isRunning()) {
    console.log(`PostgreSQL 已在运行（端口 ${PORT}）`);
    return;
  }
  mkdirSync(WORK_DIR, { recursive: true });
  const logFd = openSync(LOG_FILE, 'a');
  serverProcess = spawn(
    join(bin, 'postgres'),
    [
      '-D',
      DATA_DIR,
      '-p',
      PORT,
      '-c',
      'listen_addresses=127.0.0.1',
      '-c',
      'fsync=off',
      '-c',
      'full_page_writes=off',
    ],
    { stdio: ['ignore', logFd, logFd], windowsHide: true },
  );
  await waitForReady();
  console.log(`PostgreSQL 已启动：127.0.0.1:${PORT}`);
}

function stop() {
  const bin = requirePgBin();
  if (!isRunning()) {
    console.log('PostgreSQL 未运行');
    return;
  }
  // 用 pg_ctl stop 而不是 kill：它读 postmaster.pid 发正常关闭信号，
  // 直接终止进程会让下次启动走崩溃恢复。
  must(join(bin, 'pg_ctl'), ['-D', DATA_DIR, '-m', 'fast', '-w', 'stop']);
  console.log('PostgreSQL 已停止');
}

async function ensureServer() {
  if (!isRunning()) await start();
}

/**
 * 下载 PostgREST 官方二进制。
 *
 * 不走 `github.com/.../releases/download/...`：这台机器到 github.com 连接超时，
 * 而 api.github.com 与 release-assets.githubusercontent.com 都可达。
 * 所以用 asset API 拿直链（Accept: application/octet-stream 会 302 到 CDN），
 * 这是网络环境的具体约束，不是通用做法。
 */
async function downloadPostgrest(archive) {
  if (existsSync(archive)) return;
  const release = await (
    await fetch('https://api.github.com/repos/PostgREST/postgrest/releases/latest')
  ).json();
  const asset = release.assets?.find((entry) => entry.name.includes('windows-x86-64'));
  if (!asset) throw new Error('PostgREST 该版本没有 Windows 构建');
  console.log(`下载 PostgREST ${release.tag_name}（${asset.size} 字节）`);
  const response = await fetch(
    `https://api.github.com/repos/PostgREST/postgrest/releases/assets/${asset.id}`,
    { headers: { Accept: 'application/octet-stream' }, redirect: 'follow' },
  );
  if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createWriteStream(archive);
    Readable.fromWeb(response.body).pipe(stream);
    stream.on('finish', resolvePromise);
    stream.on('error', rejectPromise);
  });
}

async function ensurePostgrest() {
  if (existsSync(POSTGREST_BIN)) return;
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  if (process.platform !== 'win32') {
    throw new Error('本地 HTTP 集成目前只准备了 Windows 二进制，其它平台请设置 UDONE_PG_REST_BIN');
  }
  const archive = join(DOWNLOAD_DIR, 'postgrest.zip');
  await downloadPostgrest(archive);
  console.log('解压 PostgREST…');
  extractZip(archive, POSTGREST_DIR);
  if (!existsSync(POSTGREST_BIN)) {
    throw new Error(`解压后没有找到 ${POSTGREST_BIN}，请检查压缩包结构`);
  }
  copyPgRuntime(POSTGREST_DIR);
}

/**
 * PostgREST 的 Windows 构建动态链接 libpq，而不是静态链接。
 *
 * 只有 exe 不足以启动：进程会以 0xC0000135（DLL 未找到）直接退出，
 * 而且没有任何输出——看起来像「二进制坏了」，实际只是缺库。
 * 本地已经有 PostgreSQL 二进制，把它的 DLL 复制到 exe 同目录即可：
 * Windows 的 DLL 搜索顺序里，exe 所在目录优先于 PATH。
 *
 * 依赖 PATH 的做法不可靠：这个仓库的脚本可能在 Git Bash 里被启动，
 * 那里的 PATH 是 POSIX 形式，交给 Windows 加载器会失效。
 */
function copyPgRuntime(target) {
  const bin = requirePgBin();
  let copied = 0;
  for (const name of readdirSync(bin)) {
    if (!name.toLowerCase().endsWith('.dll')) continue;
    copyFileSync(join(bin, name), join(target, name));
    copied += 1;
  }
  console.log(`已复制 ${copied} 个 PostgreSQL 运行时库到 ${target}`);
}

function writePostgrestConfig() {
  writeFileSync(
    POSTGREST_CONFIG,
    [
      `db-uri = "postgres://postgres@127.0.0.1:${PORT}/${DB_NAME}"`,
      // 暴露给 PostgREST 的 schema 必须与 supabase/config.toml 的 [api] schemas 一致。
      // 少了 ops，客户端发 Accept-Profile: ops 会收到 406，而这个 406 会被
      // 读成「表不存在」——排查方向会完全跑偏。
      'db-schemas = "public,ops"',
      'db-anon-role = "anon"',
      // 与测试签 JWT 用同一个密钥；不一致时每个请求都会 401，
      // 而 401 会被误读成「鉴权中间件坏了」。
      `jwt-secret = "${JWT_SECRET}"`,
      // PostgREST 自己监听 REST_PORT+1，REST_PORT 留给只做前缀重写的网关。
      `server-port = ${Number(REST_PORT) + 1}`,
      'server-host = "127.0.0.1"',
      'db-pool = 5',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function waitForPostgrest(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (postgrestProcess && postgrestProcess.exitCode !== null) {
      throw new Error(
        `PostgREST 启动后退出（exit ${postgrestProcess.exitCode}），见 ${POSTGREST_LOG}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${Number(REST_PORT) + 1}/`);
      if (response.ok) return;
    } catch {
      // 还没监听，继续等。
    }
    await sleep(250);
  }
  throw new Error(`等待 PostgREST 就绪超时，见 ${POSTGREST_LOG}`);
}

async function startPostgrest() {
  await ensurePostgrest();
  writePostgrestConfig();
  const logFd = openSync(POSTGREST_LOG, 'a');
  postgrestProcess = spawn(POSTGREST_BIN, [POSTGREST_CONFIG], {
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  await waitForPostgrest();
  // PostgREST 直接在根路径上提供 API，而客户端拼的是 `/rest/v1/...`
  // ——生产环境里这一段前缀由 Supabase 的网关（Kong）剥掉。
  // 不在客户端或仓储层去掉前缀：那等于为了迁就测试环境去改被测代码。
  await startGateway();
  console.log(`PostgREST 已启动：http://127.0.0.1:${REST_PORT}`);
}

/**
 * 只做一件事：把 `/rest/v1/<x>` 转发到 PostgREST 的 `/<x>`。
 * 不加鉴权、不改响应、不重试——任何多余逻辑都会让「验证的是 PostgREST 行为」
 * 这句话打折扣。其它前缀一律 501，明确表示 GoTrue 不在这个栈里。
 */
function startGateway() {
  const server = createServer((request, response) => {
    const url = request.url ?? '/';
    if (!url.startsWith('/rest/v1')) {
      response.writeHead(501, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          message: 'local stack only proxies /rest/v1; Supabase Auth is not emulated',
        }),
      );
      return;
    }

    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: Number(REST_PORT) + 1,
        path: url.slice('/rest/v1'.length) || '/',
        method: request.method,
        headers: { ...request.headers, host: `127.0.0.1:${Number(REST_PORT) + 1}` },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('error', (cause) => {
      response.writeHead(502, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message: `upstream failed: ${cause.message}` }));
    });
    request.pipe(upstream);
  });

  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(REST_PORT, '127.0.0.1', () => {
      gatewayServer = server;
      resolvePromise();
    });
  });
}

function stopGateway() {
  if (!gatewayServer) return;
  gatewayServer.close();
  gatewayServer = null;
}

function stopPostgrest() {
  if (!postgrestProcess || postgrestProcess.exitCode !== null) {
    postgrestProcess = null;
    return;
  }
  postgrestProcess.kill();
  postgrestProcess = null;
}

/**
 * 组织与成员只能在库里造：没有「第一个管理员」的入口，
 * 邀请与成员管理都要求调用者已经是管理员。这一段是夹具，不是被测对象。
 */
function seedFixture() {
  writeFileSync(
    FIXTURE_SQL,
    `INSERT INTO auth.users (id, email) VALUES
  ('${USER_IDS.admin}', 'admin@integration.test'),
  ('${USER_IDS.operator}', 'operator@integration.test'),
  ('${USER_IDS.finance}', 'finance@integration.test');

INSERT INTO public.profiles (id, display_name) VALUES
  ('${USER_IDS.admin}', 'Admin'),
  ('${USER_IDS.operator}', 'Operator'),
  ('${USER_IDS.finance}', 'Finance');

INSERT INTO public.organizations (id, name, created_by)
VALUES ('${ORG_ID}', 'Integration Org', '${USER_IDS.admin}');

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('${ORG_ID}', '${USER_IDS.admin}', 'admin'),
  ('${ORG_ID}', '${USER_IDS.operator}', 'operator'),
  ('${ORG_ID}', '${USER_IDS.finance}', 'finance');

INSERT INTO auth.users (id, email) VALUES
  ('${OPS_USER_ID}', 'ops-admin@integration.test');

INSERT INTO ops.operators (id, user_id, email, display_name, status) VALUES
  ('${OPS_OPERATOR_ID}', '${OPS_USER_ID}', 'ops-admin@integration.test', 'Integration Ops', 'active');

INSERT INTO ops.operator_roles (operator_id, role_id, granted_by)
SELECT '${OPS_OPERATOR_ID}', role.id, '${OPS_OPERATOR_ID}'
FROM ops.roles AS role WHERE role.code = 'platform_admin';
`,
    'utf8',
  );
  psqlMust(DB_NAME, ['-v', 'ON_ERROR_STOP=1', '-f', FIXTURE_SQL]);
}

/**
 * 启动 → 重放 → 造夹具 → 起 PostgREST → 跑集成测试 → 全部收尾。
 *
 * 与 verify 相同，必须一条命令打包：这个 shell 结束时会把残留子进程一起收掉，
 * 分步调用的话第二次连不上库，PostgREST 也会跟着消失。
 */
async function http(...extra) {
  await ensureServer();
  try {
    replay();
    seedFixture();
    await startPostgrest();
    const vitest = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
    // 必须异步 spawn。spawnSync 会阻塞本进程的事件循环，而网关就活在这个进程里：
    // 端口能 accept（内核排队）却永远没人处理，表现是「测试全部超时」，
    // 看起来像 PostgREST 挂了，实际是网关被自己的父进程堵死。
    const child = spawn(
      process.execPath,
      [vitest, 'run', '--config', 'vitest.integration.config.ts', ...extra],
      {
        cwd: ROOT,
        stdio: 'inherit',
        windowsHide: true,
        env: {
          ...process.env,
          UDONE_REST_URL: `http://127.0.0.1:${REST_PORT}`,
          UDONE_LOCAL_JWT_SECRET: JWT_SECRET,
          UDONE_TEST_ORG_ID: ORG_ID,
          UDONE_TEST_ADMIN_ID: USER_IDS.admin,
          UDONE_TEST_OPERATOR_ID: USER_IDS.operator,
          UDONE_TEST_FINANCE_ID: USER_IDS.finance,
          UDONE_TEST_OPS_USER_ID: OPS_USER_ID,
        },
      },
    );
    return await new Promise((resolvePromise) => {
      child.on('exit', (code) => resolvePromise(code ?? 1));
      child.on('error', () => resolvePromise(1));
    });
  } finally {
    stopGateway();
    stopPostgrest();
    stop();
  }
}

function replay() {
  // 每次都从空库重放：只有「空库能一路建起来」才算迁移可重放，
  // 在已有库上增量 apply 会漏掉「建表依赖了后来才加的东西」这类问题。
  psqlMust('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB_NAME}`]);
  psqlMust('postgres', ['-c', `CREATE DATABASE ${DB_NAME}`]);
  psqlMust(DB_NAME, ['-f', join(ROOT, 'scripts', 'db', 'supabase-shim.sql')]);

  const migrationsDir = join(ROOT, 'supabase', 'migrations');
  const migrations = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of migrations) {
    try {
      psqlMust(DB_NAME, ['-v', 'ON_ERROR_STOP=1', '-f', join(migrationsDir, name)]);
    } catch (cause) {
      // 带上 cause：迁移失败时真正有用的信息往往在底层 psql 的 stderr 里。
      throw new Error(`迁移失败：${name}\n${cause instanceof Error ? cause.message : cause}`, {
        cause,
      });
    }
  }
  console.log(`迁移重放通过：${migrations.length} 个文件，库 ${DB_NAME}`);
}

function ensurePgtap() {
  const installed = psqlMust(DB_NAME, [
    '-t',
    '-A',
    '-c',
    "select count(*) from pg_proc where proname = 'plan' and pronamespace = 'public'::regnamespace",
  ]);
  if (installed.stdout.trim() !== '0') return;
  if (!existsSync(PGTAP_SQL)) {
    throw new Error('缺少 pgTAP，先运行：node scripts/db/local-db.mjs setup');
  }
  psqlMust(DB_NAME, ['-v', 'ON_ERROR_STOP=1', '-f', PGTAP_SQL]);
}

function test() {
  ensurePgtap();

  const testsDir = join(ROOT, 'supabase', 'tests');
  const files = readdirSync(testsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  let failures = 0;
  for (const name of files) {
    // `-t -A` 让 pgTAP 的 TAP 行独立成行；默认的表格格式会把 `ok 1 - …`
    // 塞进带边框的单元格，任何按行首匹配的断言计数都会失效，
    // 于是「失败」会被读成「0 个断言」而当成通过。
    const result = psql(DB_NAME, ['-v', 'ON_ERROR_STOP=1', '-t', '-A', '-f', join(testsDir, name)]);
    const output = `${result.stdout}\n${result.stderr}`.replace(/^NOTICE:\s+/gm, '');
    const passed = (output.match(/^ok \d+/gm) ?? []).length;
    const failed = (output.match(/^not ok \d+/gm) ?? []).length;
    const crashed = result.status !== 0;
    if (failed === 0 && passed === 0) {
      failures += 1;
      console.log(`FAIL ${name}（没有产生任何断言，测试文件可能失效）`);
      console.log(output.split('\n').filter(Boolean).slice(0, 20).join('\n'));
      continue;
    }
    if (failed > 0 || crashed) {
      failures += 1;
      console.log(`FAIL ${name}（通过 ${passed}，失败 ${failed}${crashed ? '，执行报错' : ''}）`);
      // 只打印失败行与报错，成功行没有信息量。
      const relevant = output
        .split('\n')
        .filter((line) => /^not ok|# |ERROR|FATAL|DETAIL|CONTEXT|HINT/.test(line))
        .slice(0, 40);
      console.log(relevant.join('\n'));
    } else {
      console.log(`ok   ${name}（${passed} 个断言）`);
    }
  }

  if (failures > 0) console.error(`\n${failures} / ${files.length} 个测试文件未通过`);
  else console.log(`\n全部通过：${files.length} 个测试文件`);
  return failures;
}

/**
 * 启动 → 重放 → 测试 → 停止，全在一条命令里做完。
 *
 * 必须这样打包：这个 shell 在命令结束时会把残留子进程一起收掉，
 * 分三次调用的话第二次连不上库（第一次的 postgres 已经被杀了）。
 */
async function verify() {
  await ensureServer();
  try {
    replay();
    return test();
  } finally {
    stop();
  }
}

async function sql(statement) {
  await ensureServer();
  try {
    process.stdout.write(psqlMust(DB_NAME, ['-c', statement]).stdout);
  } finally {
    stop();
  }
}

const commands = { setup, start, stop, replay, test, verify, sql, http };

// 允许被 import（例如集成测试想复用启停逻辑）而不触发 CLI 分支。
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const [command, ...rest] = process.argv.slice(2);
  if (!commands[command]) {
    console.error(`用法：node scripts/db/local-db.mjs <${Object.keys(commands).join('|')}> [参数]`);
    process.exitCode = 2;
  } else {
    try {
      const outcome = await commands[command](...rest);
      // 用 exitCode 而不是 process.exit()：管道上的 stdout 是异步写，
      // 直接 exit 会把还没 flush 的日志整段吞掉，排查时只剩一个退出码。
      if (typeof outcome === 'number' && outcome > 0) process.exitCode = 1;
    } catch (cause) {
      console.error(cause instanceof Error ? cause.message : cause);
      process.exitCode = 1;
    }
  }
}

export { ORG_ID, USER_IDS, OPS_USER_ID, OPS_OPERATOR_ID, JWT_SECRET, REST_PORT, DB_NAME, PORT };
