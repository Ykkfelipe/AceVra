#!/usr/bin/env node
// 组装 canonical handoff。handoff 是本地最终分发包的唯一持久所有者（策略见
// AGENTS.md「本地构建产物管理」）：
//   - 归档（DMG/ZIP）从 BUILD 目录取；同卷优先 hardlink（不产生第二份物理拷贝，
//     随后的 compaction 删除 build 侧名字后只剩 handoff 一份 inode），跨卷回退为拷贝。
//   - 侧车（build-info.json / RELEASE_NOTES.md / SHA256SUMS.txt）使用校验阶段写入的
//     validation 报告；validation 不再持有 .app/DMG/ZIP 副本。
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const required = [`AceVra-${version}-arm64.dmg`, `AceVra-${version}-arm64.zip`];
const sidecars = ["build-info.json", "RELEASE_NOTES.md", "SHA256SUMS.txt"];

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
const build = resolve(arg("--build-dir", join(root, "release", "0.1.0-alpha.1", "build")));
const validation = resolve(
  arg("--validation-dir", join(root, "release", "0.1.0-alpha.1", "validation")),
);
const handoff = resolve(arg("--handoff-dir", join(root, "release", "0.1.0-alpha.1", "handoff")));
if (!existsSync(build) || !existsSync(validation) || existsSync(handoff))
  throw new Error("build/validation directory missing or handoff already exists");
if (!existsSync(join(validation, "build-info.json")))
  throw new Error("validation report is missing build-info.json");
const staging = `${handoff}.staging-${process.pid}`;
mkdirSync(staging);
for (const name of required) {
  const source = join(build, name);
  if (!existsSync(source)) throw new Error(`build output is missing ${name}`);
  const target = join(staging, name);
  try {
    // hardlink：canonical 归档与临时 build 产物共享 inode，不额外占用磁盘。
    linkSync(source, target);
  } catch {
    copyFileSync(source, target);
  }
}
writeFileSync(join(staging, "build-info.json"), readFileSync(join(validation, "build-info.json")));
writeFileSync(
  join(staging, "RELEASE_NOTES.md"),
  `# AceVra ${version}\n\nSelf-signed, non-notarized local engineering alpha. No Developer ID or public distribution claim.\n`,
);
writeFileSync(
  join(staging, "SHA256SUMS.txt"),
  required.map((name) => `${sha256(join(staging, name))}  ${name}`).join("\n") + "\n",
);
const actual = readdirSync(staging).sort();
const expected = [...required, ...sidecars].sort();
if (actual.join("\n") !== expected.join("\n"))
  throw new Error(`handoff file allowlist mismatch: ${actual.join(", ")}`);
for (const line of readFileSync(join(staging, "SHA256SUMS.txt"), "utf8").trim().split("\n")) {
  const [digest, name] = line.split("  ");
  if (sha256(join(staging, name)) !== digest) throw new Error(`checksum mismatch: ${name}`);
}
renameSync(staging, handoff);
console.log(`[handoff] assembled ${handoff}`);
