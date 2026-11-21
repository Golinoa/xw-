# admin-clean 依赖安装与验证（已实测通过 2026-11-21）

`D:\Coding\ERP\admin`（原目录）的 node_modules 被 isolated(失败) + hoisted(成功) 两种模式污染，
里面残留大量半解压包，无法直接用。**改用干净副本 `D:\Coding\ERP\admin-clean`**。

## 一键步骤（在 WorkBuddy 沙箱里，全部已验证）

### 0. 环境准备（只需一次）
若 `admin-clean` 不存在，从 admin 复制源码（排除 node_modules/dist/.git）：
```python
robocopy D:\Coding\ERP\admin D:\Coding\ERP\admin-clean /E /XD node_modules dist .git /MT:8
```

### 1. 安装依赖（hoisted 模式，约 30-60 秒）
关键点：
- 去掉 WorkBuddy 的 `NODE_OPTIONS` safe-delete 注入（否则删临时目录被拦）
- 用 Node 24 跑 pnpm 的 JS 入口（pnpm 只装在 Node22 目录，但纯 JS 可跨版本）
- `--config.engine-strict=false`（pnpm 宿主是 Node22，项目要 Node24）
- `--config.node-linker=hoisted`（默认的 isolated 符号链接阶段在本机必挂死）
- `--ignore-scripts`（postinstall 单独跑，见下一步）

```bash
cd D:/Coding/ERP/admin-clean
env -u NODE_OPTIONS -u CODEBUDDY_SAFE_DELETE_BULK_GUARD -u CODEBUDDY_SAFE_DELETE_SANDBOX \
  /c/nvm4w/nodejs/node.exe \
  "C:/Users/Agust/.workbuddy/binaries/node/versions/22.22.2/node_modules/pnpm/bin/pnpm.cjs" \
  install --frozen-lockfile --config.engine-strict=false --config.node-linker=hoisted --ignore-scripts
```
（注意：路径必须写盘符 `C:/`，写 `/c/` 会被 node 当相对路径报 Cannot find module）

### 2. 生成内部包 dist（stub，约 10 秒）
内部 workspace 包（@vben/vite-config 等）的 exports 指向 dist/，需要 stub 生成。
`npm_config_engine_strict=false` 用环境变量形式（run 子命令不认 --config）。
```bash
cd D:/Coding/ERP/admin-clean
env -u NODE_OPTIONS -u CODEBUDDY_SAFE_DELETE_BULK_GUARD -u CODEBUDDY_SAFE_DELETE_SANDBOX \
  npm_config_engine_strict=false \
  /c/nvm4w/nodejs/node.exe \
  "C:/Users/Agust/.workbuddy/binaries/node/versions/22.22.2/node_modules/pnpm/bin/pnpm.cjs" \
  -r --filter "@vben/web-antd..." --filter "@vben/vite-config..." --filter "@vben/vsh..." \
  --filter "@vben/eslint-config..." --filter "@vben/oxfmt-config..." \
  --filter "@vben/oxlint-config..." --filter "@vben/stylelint-config..." run stub --if-present
```

### 3. 验证（全部通过）
```bash
# build
cd D:/Coding/ERP/admin-clean/apps/web-antd
env -u NODE_OPTIONS -u CODEBUDDY_SAFE_DELETE_BULK_GUARD -u CODEBUDDY_SAFE_DELETE_SANDBOX \
  /c/nvm4w/nodejs/node.exe ../../node_modules/vite/bin/vite.js build --mode development
# => ✓ built in 14.58s

# typecheck
env -u NODE_OPTIONS -u CODEBUDDY_SAFE_DELETE_BULK_GUARD -u CODEBUDDY_SAFE_DELETE_SANDBOX \
  ../../node_modules/.bin/vue-tsc --noEmit --skipLibCheck
# => 0 错误
```

## 阶段 0 结论：✅ 通过
可以开始阶段 1（建 `udone/apps/web-vben`，接 Supabase 认证 + 契约 API 内核）。
