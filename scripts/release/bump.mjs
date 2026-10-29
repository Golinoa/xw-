#!/usr/bin/env node
/**
 * 提升某组件的版本并写回清单。
 * 只改 .release/manifest.json，不动任何 package.json：
 * admin 的 package.json 版本属于 Vben 上游，改了会与 changeset / 上游同步打架。
 *
 * 用法：node scripts/release/bump.mjs udone patch
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ReleaseError, bumpVersion, formatTag } from "./lib.mjs";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const manifestPath = resolve(repoRoot, ".release", "manifest.json");

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}

const [component, kind, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const components = manifest.components ?? {};

if (!component) {
  fail(
    `用法: node scripts/release/bump.mjs <组件> <patch|minor|major>\n可用组件：${Object.keys(components).join(" / ")}`,
  );
}
if (!kind) {
  fail(
    `缺少递增类型，可用 patch / minor / major。当前版本 ${components[component]?.version ?? "未知"}`,
  );
}

const target = components[component];
if (!target) {
  fail(
    `未知组件「${component}」，可用组件：${Object.keys(components).join(" / ")}`,
  );
}

let nextVersion;
try {
  nextVersion = bumpVersion(target.version, kind);
} catch (error) {
  if (error instanceof ReleaseError) fail(error.message);
  throw error;
}

const previousVersion = target.version;
target.version = nextVersion;
if (dryRun) {
  console.log(
    `${component}: ${previousVersion} → ${nextVersion}（--dry-run，未写入清单）`,
  );
} else {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`${component}: ${previousVersion} → ${nextVersion}`);
}

const tag = formatTag(target.tagPrefix, nextVersion);
console.log("");
console.log("接下来按顺序执行：");
console.log(`  git add .release/manifest.json`);
console.log(`  git commit -m "chore(release): ${component} ${nextVersion}"`);
console.log(`  git tag ${tag}`);
console.log(`  git push origin HEAD:main`);
console.log(`  git push origin ${tag}`);
console.log("");
console.log("推送 tag 后流水线自动触发，产物版本即 " + nextVersion + "。");
