#!/usr/bin/env node
// 本地构建产物盘点（只读报告，绝不删除任何文件）。
//
// 背景：本地 alpha 打包曾按 sha 在 release/ 下堆积 build-*/validation-*/handoff-* 目录，
// 并在 /Applications 累积 20+ 份 .AceVra.app.backup-*（每份约 558 MB），几度把开发者磁盘
// 占满。永久策略见 AGENTS.md「本地构建产物管理」与 release/0.1.0-alpha.1/HOW_TO_UPDATE.md：
//   - 固定工作区 release/0.1.0-alpha.1/{build,validation,handoff}/，打包前清空重建；
//   - 不再创建 build-<sha>/、candidate-<sha>/、validation-<sha>/、handoff-<sha>/ 等派生目录；
//   - /Applications 最多保留 AceVra.app 加一份上一代已知可用回滚副本；
//   - DMG/ZIP 只保留当前候选最新产物，不在多个目录堆积同名副本。
//
// 本脚本在打包前运行：报告固定工作区、陈旧代次目录、DMG/ZIP 与已安装回滚副本的体积，
// 对陈旧代次打印警告。判定不了的只列出、不推断。永远退出 0 —— node_modules 偏大等
// 普通开发开销绝不构成失败；清理由人按报告路径执行，脚本本身不删任何东西。
//
// 用法：node scripts/release/artifact-report.mjs [--apps-dir /Applications]

import { execFile as execFileCallback } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const releaseRoot = join(repoRoot, "release");
const appsDir = resolve(argValue("--apps-dir") ?? "/Applications");

// 固定工作区目录名；其余目录按陈旧代次模式识别，识别不了的只列出。
const FIXED_DIRS = new Set(["build", "validation", "handoff"]);
const STALE_DIR_RE = /^(build|validation|handoff|candidate|precommit|repaired|fresh)[-_.][^/]+$/;
const ARCHIVE_RE = /\.(dmg|zip)$/i;
const APP_BACKUP_RE = /^\.AceVra\.app\.backup-/;
// 同名 DMG/ZIP 出现在多个固定目录属当前代次正常现象；只有跨目录 mtime 差超过一天才提示。
const GENERATION_DRIFT_MS = 24 * 60 * 60 * 1000;

function formatKiB(kib) {
  if (!Number.isFinite(kib)) return "?";
  if (kib >= 1024 * 1024) return `${(kib / 1024 / 1024).toFixed(2)} GB`;
  if (kib >= 1024) return `${(kib / 1024).toFixed(1)} MB`;
  return `${kib} KiB`;
}

async function measurePaths(paths) {
  const sizes = new Map();
  const missing = paths.filter((path) => path !== undefined);
  if (missing.length === 0) return sizes;
  try {
    const { stdout } = await execFile("du", ["-sk", ...missing]);
    for (const line of stdout.split("\n")) {
      const match = line.match(/^(\d+)\t(.+)$/);
      if (match) sizes.set(match[2], Number(match[1]));
    }
  } catch (error) {
    // du 对个别不可读路径会以非零退出，但已输出的行仍然有效。
    const stdout = error?.stdout;
    if (typeof stdout === "string") {
      for (const line of stdout.split("\n")) {
        const match = line.match(/^(\d+)\t(.+)$/);
        if (match) sizes.set(match[2], Number(match[1]));
      }
    }
  }
  return sizes;
}

async function listDir(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return null;
  }
}

function warn(message) {
  console.log(`[artifacts][WARN] ${message}`);
}

function info(message) {
  console.log(`[artifacts] ${message}`);
}

async function reportReleaseTree() {
  const versionDirs = (await listDir(releaseRoot)) ?? [];
  const versionNames = versionDirs.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (versionNames.length === 0) {
    info(`release/ 下没有版本目录（${releaseRoot}）`);
    return;
  }

  const versionPaths = versionNames.map((name) => join(releaseRoot, name));
  const versionSizes = await measurePaths(versionPaths);

  const staleSuspects = [];
  const otherDirs = [];
  const archiveRows = [];

  for (const name of versionNames) {
    const versionDir = join(releaseRoot, name);
    info(`release/${name}: ${formatKiB(versionSizes.get(versionDir))}`);
    const entries = (await listDir(versionDir)) ?? [];
    const subDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

    for (const subName of subDirs) {
      const subPath = join(versionDir, subName);
      if (FIXED_DIRS.has(subName)) continue;
      if (STALE_DIR_RE.test(subName)) {
        staleSuspects.push(subPath);
      } else {
        otherDirs.push(subPath);
      }
    }

    for (const entry of entries) {
      if (entry.isFile() && ARCHIVE_RE.test(entry.name)) {
        archiveRows.push({ path: join(versionDir, entry.name), name: entry.name, home: `release/${name}` });
      }
    }
  }

  // 固定工作区目录与包内归档
  for (const name of versionNames) {
    const versionDir = join(releaseRoot, name);
    const entries = (await listDir(versionDir)) ?? [];
    const fixedPresent = [];
    for (const fixedName of FIXED_DIRS) {
      if (!entries.some((entry) => entry.isDirectory() && entry.name === fixedName)) continue;
      const fixedPath = join(versionDir, fixedName);
      const sizes = await measurePaths([fixedPath]);
      fixedPresent.push(`${fixedName}/ ${formatKiB(sizes.get(fixedPath))}`);
      const fixedEntries = (await listDir(fixedPath)) ?? [];
      for (const entry of fixedEntries) {
        if (entry.isFile() && ARCHIVE_RE.test(entry.name)) {
          const filePath = join(fixedPath, entry.name);
          const fileStat = await stat(filePath).catch(() => null);
          archiveRows.push({
            path: filePath,
            name: entry.name,
            home: `release/${name}/${fixedName}`,
            mtimeMs: fileStat?.mtimeMs,
          });
        }
      }
    }
    if (fixedPresent.length > 0) {
      info(`  固定工作区: ${fixedPresent.join(" | ")}`);
    }
  }

  if (staleSuspects.length > 0) {
    const staleSizes = await measurePaths(staleSuspects);
    const staleTotal = staleSuspects.reduce((sum, path) => sum + (staleSizes.get(path) ?? 0), 0);
    warn(`检测到 ${staleSuspects.length} 个陈旧代次目录（按 SHA/时间戳派生，策略要求不再创建）：`);
    for (const path of staleSuspects) {
      console.log(`                 - ${path} (${formatKiB(staleSizes.get(path))})`);
    }
    warn(`陈旧代次目录合计约 ${formatKiB(staleTotal)}，确认后可按 AGENTS.md 清理。`);
  }
  for (const path of otherDirs) {
    const sizes = await measurePaths([path]);
    info(`  其他目录（不确定，请人工判断，本脚本不做结论）: ${path} (${formatKiB(sizes.get(path))})`);
  }

  // 版本目录根部散落的 DMG/ZIP（不在固定工作区内，home 形如 release/<version>）
  for (const row of archiveRows.filter((r) => r.home.split("/").length === 2)) {
    warn(`DMG/ZIP 散落在版本目录根部（应在固定工作区内）: ${row.path}`);
  }

  // 同名归档跨固定目录的代次漂移检查
  const byName = new Map();
  for (const row of archiveRows) {
    if (row.mtimeMs === undefined) continue;
    if (!byName.has(row.name)) byName.set(row.name, []);
    byName.get(row.name).push(row);
  }
  for (const [name, rows] of byName) {
    const times = rows.map((row) => row.mtimeMs);
    const drift = Math.max(...times) - Math.min(...times);
    info(`归档 ${name}: ${rows.length} 份（${rows.map((row) => row.home).join(", ")}）`);
    if (rows.length > 1 && drift > GENERATION_DRIFT_MS) {
      warn(`同名归档 ${name} 的 mtime 跨度超过 24 小时，可能混有上一代产物，请核对后清理旧份。`);
    }
  }
}

async function reportInstalledApps() {
  const entries = await listDir(appsDir);
  if (!entries) {
    info(`无法读取 ${appsDir}，跳过已安装应用盘点`);
    return;
  }
  const current = entries.find((entry) => entry.isDirectory() && entry.name === "AceVra.app");
  const backups = entries.filter((entry) => entry.isDirectory() && APP_BACKUP_RE.test(entry.name));

  if (!current) {
    info(`${appsDir}/AceVra.app 不存在`);
  }
  const currentPath = join(appsDir, "AceVra.app");
  const backupPaths = backups.map((entry) => join(appsDir, entry.name));
  const sizes = await measurePaths([current ? currentPath : undefined, ...backupPaths]);

  if (current) {
    info(`已安装候选: ${currentPath} (${formatKiB(sizes.get(currentPath))})`);
  }
  if (backups.length === 0) {
    info("没有 /Applications/.AceVra.app.backup-* 回滚副本");
    return;
  }

  const stats = await Promise.all(
    backupPaths.map(async (path) => ({ path, mtimeMs: (await stat(path).catch(() => null))?.mtimeMs ?? 0 })),
  );
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  info(`回滚副本共 ${stats.length} 份（策略：最多保留最近一份）：`);
  for (const [index, entry] of stats.entries()) {
    const label = index === 0 ? "KEEP ONE ROLLBACK（最近一份）" : "SAFE STALE ARTIFACT（超过一代，验证通过后可删）";
    console.log(`  - ${entry.path} (${formatKiB(sizes.get(entry.path))}, ${new Date(entry.mtimeMs).toISOString()}) [${label}]`);
  }
  if (stats.length > 1) {
    warn(`存在 ${stats.length} 份回滚副本；策略要求只保留最近一份，其余合计约 ${formatKiB(stats.slice(1).reduce((sum, entry) => sum + (sizes.get(entry.path) ?? 0), 0))}。`);
  }
}

async function main() {
  console.log("[artifacts] 本地构建产物盘点（只读，不删除；策略见 AGENTS.md「本地构建产物管理」）");
  await reportReleaseTree();
  await reportInstalledApps();
  console.log(
    "[artifacts] 永不纳入产物清理：源码、.git、node_modules、userData/会话数据、本地 profile、签名证书与 keychain、TCC 状态、已接受的测试证据/报告、.spike/。",
  );
  console.log("[artifacts] 本脚本只报告；清理由人按路径执行，判定不了的项目保持 UNKNOWN —— 不要删除。");
  process.exitCode = 0;
}

await main();
