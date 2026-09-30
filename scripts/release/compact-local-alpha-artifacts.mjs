#!/usr/bin/env node
// 同代际压实：handoff 校验通过后，删除 build/ 与 validation/ 里冗余的最终产物副本。
//
// 策略（AGENTS.md「本地构建产物管理」）：handoff 是本地最终分发包的唯一持久所有者；
// build/ 只保留中间产物，validation/ 只保留报告。固定目录消除历史堆积，本脚本消除
// **同代际**的重复物理拷贝（每份 .app ~600MB、DMG+ZIP ~360MB）。
//
// 前提（fail-closed：任一不满足即拒绝并保持原状）：
//   1) handoff 目录五件套齐全且 SHA256SUMS 全部校验通过；
//   2) 只按固定 allowlist 路径删除 —— 绝不做目录级通配清理、绝不动报告与日志。
//
// 说明：assembler 同卷 hardlink 时，删除 build 侧名字不会释放磁盘（剩余 handoff 名字
// 仍指向同一 inode）；脚本对 nlink>1 的条目不计入回收量，避免虚报。

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const dmg = `AceVra-${version}-arm64.dmg`;
const zip = `AceVra-${version}-arm64.zip`;
const required = [dmg, zip];
const sidecars = ["build-info.json", "RELEASE_NOTES.md", "SHA256SUMS.txt"];

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
/** 真实可回收字节数：nlink>1（硬链接）的条目删除后不释放磁盘，计 0。 */
function reclaimableSize(path) {
  const st = lstatSync(path);
  if (st.isDirectory()) {
    return readdirSync(path).reduce((sum, name) => sum + reclaimableSize(join(path, name)), 0);
  }
  if (!st.isFile()) return 0;
  return st.nlink > 1 ? 0 : st.size;
}
function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${bytes} B`;
}

const build = resolve(arg("--build-dir", join(root, "release", "0.1.0-alpha.1", "build")));
const validation = resolve(
  arg("--validation-dir", join(root, "release", "0.1.0-alpha.1", "validation")),
);
const handoff = resolve(arg("--handoff-dir", join(root, "release", "0.1.0-alpha.1", "handoff")));

// 前提 1：canonical handoff 必须完整且校验通过，否则什么都不删。
if (!existsSync(handoff)) throw new Error(`handoff directory is missing: ${handoff}`);
const handoffEntries = readdirSync(handoff).sort();
const handoffExpected = [...required, ...sidecars].sort();
if (handoffEntries.join("\n") !== handoffExpected.join("\n")) {
  throw new Error(`handoff allowlist mismatch — refuse to compact: ${handoffEntries.join(", ")}`);
}
for (const line of readFileSync(join(handoff, "SHA256SUMS.txt"), "utf8").trim().split("\n")) {
  const [digest, name] = line.split("  ");
  if (sha256(join(handoff, name)) !== digest) {
    throw new Error(`handoff checksum mismatch — refuse to compact: ${name}`);
  }
}

// 前提 2：固定 allowlist。build/ 的 mac-arm64 app 树与顶层归档/块映射是中间产物；
// validation/ 里出现 .app/DMG/ZIP 只可能是旧版流水线留下的同代际副本。
const targets = [];
for (const name of ["mac-arm64", dmg, zip]) {
  const path = join(build, name);
  if (existsSync(path)) targets.push(path);
}
if (existsSync(build)) {
  for (const name of readdirSync(build)) {
    if (name.endsWith(".blockmap")) targets.push(join(build, name));
  }
}
for (const name of ["AceVra.app", dmg, zip]) {
  const path = join(validation, name);
  if (existsSync(path)) targets.push(path);
}

let reclaimed = 0;
let removed = 0;
for (const path of targets) {
  const size = reclaimableSize(path);
  rmSync(path, { recursive: true, force: true });
  reclaimed += size;
  removed += 1;
  console.log(`[compact] removed ${path} (reclaimable ${formatBytes(size)})`);
}
console.log(
  `[compact] removed ${removed} same-generation ${removed === 1 ? "copy" : "copies"}; ` +
    `reclaimed ${formatBytes(reclaimed)}; canonical handoff retained at ${handoff}`,
);
