#!/usr/bin/env node
/**
 * 发布前校验：确认 tag 指向的组件与清单版本一致。
 * 在流水线里作为第一道闸，不一致就不往下构建，避免产物版本与 tag 漂移。
 *
 * 用法：node scripts/release/verify.mjs udone-v1.2.3
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ReleaseError, assertVersionMatch } from "./lib.mjs";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const manifestPath = resolve(repoRoot, ".release", "manifest.json");

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}

const tag = process.argv[2];
if (!tag) fail("用法: node scripts/release/verify.mjs <tag>");

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`读取 ${manifestPath} 失败：${error.message}`);
}

try {
  const resolved = assertVersionMatch(tag, manifest);
  // key=value 而非 JSON：流水线里用 awk 取值即可，不依赖 jq。
  console.log(`component=${resolved.component}`);
  console.log(`version=${resolved.version}`);
  console.log(`path=${resolved.path}`);
  console.log(`displayName=${resolved.displayName}`);
  console.log(`tag=${tag}`);
  console.error(`[release] 校验通过：${tag} → ${resolved.path}`);
} catch (error) {
  if (error instanceof ReleaseError) fail(error.message);
  throw error;
}
