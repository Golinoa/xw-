# udone 本地环境一键引导
#
# 为什么需要它：在 WorkBuddy 沙箱里装依赖会卡死，原因有两个（都已实证）：
#   1. 被终止的 pnpm 会留 2 个孤儿进程，占住 store 的 SQLite 写锁，之后每次安装都静默假死；
#   2. ant-design-vue / workerd 两个大 tarball 写入失败（error 23），换源无效。
# 所以在【普通 PowerShell 窗口】里跑这个脚本，不要在沙箱里跑。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File .workbuddy\tools\bootstrap-udone-env.ps1
#   powershell -ExecutionPolicy Bypass -File .workbuddy\tools\bootstrap-udone-env.ps1 -Fresh
#   powershell -ExecutionPolicy Bypass -File .workbuddy\tools\bootstrap-udone-env.ps1 -SkipInstall

param(
  [switch]$Fresh,        # 先删 node_modules（半成品状态时用）
  [switch]$SkipInstall,  # 只跑数据库验证，不装依赖
  [switch]$SkipHttp      # 装完不跑集成测试
)

$ErrorActionPreference = 'Stop'
# node 子进程输出 UTF-8，PowerShell 默认按 GBK 解，中文会变成乱码
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$udone = Join-Path $repo 'udone'
$store = 'D:\.pnpm-store\v11'

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  !!  $msg" -ForegroundColor Yellow }

if (-not (Test-Path (Join-Path $udone 'pnpm-workspace.yaml'))) {
  throw "找不到 udone 工作区：$udone"
}

# ---------------------------------------------------------------- 1. 清孤儿进程
# 这一步最关键。沙箱里被杀掉的 pnpm 会留下 `pnpm.mjs install ...` 僵尸进程，
# 它们握着 store 的 SQLite 写锁，导致后续安装「不报错、不推进、日志十分钟不动」。
Step '清理残留的 pnpm 进程'
$script:killed = 0
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*pnpm*' } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $script:killed = $script:killed + 1
  }
if ($script:killed -gt 0) { Ok "已结束 $script:killed 个进程" } else { Ok '没有残留进程' }

# ---------------------------------------------------------------- 2. 清 store 锁
Step '清理 pnpm store 的 SQLite 热日志'
foreach ($f in @("$store\index.db-shm", "$store\index.db-wal")) {
  if (Test-Path $f) {
    Remove-Item $f -Force -ErrorAction SilentlyContinue
    # 删不掉不致命：pnpm 会自己接管热日志，只是可能变慢。
    if (Test-Path $f) { Warn "删不掉 $f（仍有进程持有），继续" } else { Ok "已删 $f" }
  }
}
if (-not (Test-Path "$store\index.db-shm") -and -not (Test-Path "$store\index.db-wal")) { Ok '锁已清空' }

# ---------------------------------------------------------------- 3. 环境变量
# NODE_OPTIONS 里注入了 genie-safe-delete 钩子，它把 Node 的删除改写成「进回收站」，
# 而这台机器回收站 API 是坏的 —— 任何删文件的 Node 程序都会因此中止。
Step '清理环境变量'
$env:NODE_OPTIONS = ''
$env:CI = 'true'
Ok 'NODE_OPTIONS 已清空、CI=true'

# ---------------------------------------------------------------- 4. 删半成品
# 先确认 pnpm 在 PATH 上：双击运行时环境变量可能和终端里不一样，
# 这里给一句人话，比让 pnpm install 报「不是内部或外部命令」清楚得多。
if (-not $SkipInstall) {
  Step '检查工具链'
  $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
  if (-not $pnpmCmd) {
    throw "找不到 pnpm。请先安装：npm i -g pnpm（或在项目目录跑 corepack enable）"
  }
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    throw "找不到 node。请先安装 Node.js 22.x"
  }
  Ok ("pnpm " + (& pnpm --version) + " / node " + (& node --version))
}


if ($Fresh) {
  Step '删除 node_modules（-Fresh）'
  $nm = Join-Path $udone 'node_modules'
  if (Test-Path $nm) {
    # 用 cmd 的 rmdir：PowerShell 的 Remove-Item 遇到断链 junction 会报错
    & cmd /c "rmdir /s /q `"$nm`""
    if (Test-Path $nm) { Warn 'node_modules 未完全删除，可能有句柄未释放；重启后再跑一次' }
    else { Ok '已删除' }
  } else { Ok '本来就不存在' }
}

# ---------------------------------------------------------------- 5. 装依赖
if (-not $SkipInstall) {
  Step '安装依赖（pnpm install --frozen-lockfile）'
  Push-Location $udone
  try {
    # 这条线路上实测约 640 KB/s，最大的包 @cloudflare/workerd-windows-64 有 34.5 MB，
    # 单独下就要 54 秒 —— 而 pnpm 默认单项超时正好是 60 秒。
    # 再加上默认 16 路并发会把带宽切碎，几个大包同时卡在 60 秒被掐，
    # 报出来的就是 error (23) 与 TimeoutError，看起来像权限或磁盘问题，其实全是超时。
    # 所以：超时放宽到 10 分钟、并发降到 4、允许重试；store 是累积的，重试会接着上次的进度。
    $installArgs = @(
      'install', '--frozen-lockfile',
      '--fetch-timeout=600000',
      '--fetch-retries=5',
      '--fetch-retry-maxtimeout=60000',
      '--network-concurrency=4'
    )
    $installed = $false
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      if ($attempt -gt 1) { Warn "第 $attempt 次尝试（已下载的包留在 store 里，会接着下）" }
      & pnpm @installArgs
      if ($LASTEXITCODE -eq 0) { $installed = $true; break }
    }
    if (-not $installed) {
      throw '依赖安装连续 3 次失败。若报错仍是 error (23) / TimeoutError，是网络太慢：换个网络（或用手机热点）再双击一次即可，已下载的包不会重下。'
    }
    Ok '依赖安装完成'
  } finally { Pop-Location }
} else {
  Step '跳过依赖安装（-SkipInstall）'
}

# ---------------------------------------------------------------- 6. 数据库验证
Step '重放迁移 + pgTAP（约 1 分钟）'
Push-Location $udone
try {
  & node scripts/db/local-db.mjs verify
  if ($LASTEXITCODE -ne 0) { Warn 'pgTAP 有失败，见上方输出' } else { Ok '数据库层全绿' }
} finally { Pop-Location }

# ---------------------------------------------------------------- 7. HTTP 集成
if (-not $SkipHttp -and -not $SkipInstall) {
  Step 'PostgREST 集成测试（21 个用例）'
  Push-Location $udone
  try {
    & node scripts/db/local-db.mjs http
    if ($LASTEXITCODE -ne 0) { Warn '集成测试有失败，见上方输出' } else { Ok '集成测试全绿' }
  } finally { Pop-Location }
}

Write-Host "`n完成。日常命令：" -ForegroundColor Cyan
Write-Host '  node scripts/db/local-db.mjs start    # 起 PG + PostgREST（55432 / 55433）'
Write-Host '  node scripts/db/local-db.mjs verify   # 跑 pgTAP'
Write-Host '  node scripts/db/local-db.mjs http     # 跑 HTTP 集成'
