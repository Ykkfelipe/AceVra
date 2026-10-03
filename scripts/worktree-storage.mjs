#!/usr/bin/env node
// Git worktree 磁盘预算：盘点（默认只读）与冷存（删除可重建的依赖/构建输出）。
//
// 背景：每个链接 worktree 都独立 `pnpm install`（约 3 GB node_modules）并生成
// `.zcode-runtime`（约 260 MB）。并行开发曾同时保留 9 个 worktree，把 228 GB 磁盘占到只剩
// 13 GB。永久策略见 AGENTS.md「Worktree 与磁盘预算」：
//   - 链接 worktree 同时最多保留 MAX_LINKED 个；新建前先运行本脚本；
//   - 已完成的 worktree 用 `git worktree remove` 移除（分支仍在 Git 中）；
//   - 暂停但还要回来的 worktree 冷存：删除依赖与构建输出，恢复时 `pnpm install`。
//
// 冷存只删除 node_modules、.turbo 与 packages/*/{dist,out}；源码、.git、.spike、
// .zcode-runtime、release/ 与未跟踪文件一律不动。主检出、当前所在 worktree、
// 以及有进程命令行引用其路径的 worktree 拒绝冷存。
//
// 用法：
//   node scripts/worktree-storage.mjs                      # 只读报告
//   node scripts/worktree-storage.mjs --cold <名称|路径>...  # 冷存指定 worktree
//   node scripts/worktree-storage.mjs --cold --all          # 冷存除主检出与当前外的全部

import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const MAX_LINKED = 3;
const WARN_FREE_GB = 25;
const CRITICAL_FREE_GB = 15;
const REBUILDABLE_ANY_DEPTH = ["node_modules", ".turbo"];
const REBUILDABLE_PACKAGE_OUTPUTS = ["dist", "out"];

const args = process.argv.slice(2);
const coldMode = args.includes("--cold");
const coldAll = args.includes("--all");
const coldTargets = args.filter((arg) => !arg.startsWith("--"));

const currentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function run(command, commandArgs, options = {}) {
  try {
    const { stdout } = await execFile(command, commandArgs, {
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
    return stdout;
  } catch (error) {
    // du/find 对个别不可读路径会以非零退出，但已输出的内容仍然有效。
    return typeof error?.stdout === "string" ? error.stdout : "";
  }
}

function formatKiB(kib) {
  if (!Number.isFinite(kib)) return "?";
  if (kib >= 1024 * 1024) return `${(kib / 1024 / 1024).toFixed(1)} GB`;
  if (kib >= 1024) return `${(kib / 1024).toFixed(0)} MB`;
  return `${kib} KiB`;
}

async function listWorktrees() {
  const stdout = await run("git", ["-C", currentRoot, "worktree", "list", "--porcelain"]);
  const worktrees = [];
  let entry;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      entry = { path: line.slice("worktree ".length), branch: "(detached)" };
      worktrees.push(entry);
    } else if (line.startsWith("branch ") && entry) {
      entry.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  // git 总是先列出主检出。
  worktrees.forEach((worktree, index) => {
    worktree.isMain = index === 0;
    worktree.isCurrent = resolve(worktree.path) === currentRoot;
  });
  return worktrees;
}

async function freeSpaceKiB() {
  const stdout = await run("df", ["-k", currentRoot]);
  const columns = stdout.trim().split("\n").at(-1)?.split(/\s+/) ?? [];
  return Number(columns[3]);
}

async function sizesKiB(paths) {
  const sizes = new Map();
  const existing = paths.filter((path) => existsSync(path));
  if (existing.length === 0) return sizes;
  const stdout = await run("du", ["-sk", ...existing]);
  for (const line of stdout.split("\n")) {
    const match = line.match(/^(\d+)\t(.+)$/);
    if (match) sizes.set(match[2], Number(match[1]));
  }
  return sizes;
}

async function processesUsing(worktreePath) {
  const stdout = await run("ps", ["-axo", "pid=,command="]);
  const prefix = `${worktreePath}/`;
  return stdout
    .split("\n")
    .filter((line) => line.includes(prefix) && !line.includes("worktree-storage.mjs"))
    .map((line) => line.trim());
}

async function rebuildableDirs(worktreePath) {
  const nameArgs = REBUILDABLE_ANY_DEPTH.flatMap((name, index) =>
    index === 0 ? ["-name", name] : ["-o", "-name", name],
  );
  const stdout = await run("find", [
    worktreePath,
    "-path",
    join(worktreePath, ".git"),
    "-prune",
    "-o",
    "-type",
    "d",
    "(",
    ...nameArgs,
    ")",
    "-prune",
    "-print",
  ]);
  const dirs = stdout.split("\n").filter(Boolean);
  const packagesDir = join(worktreePath, "packages");
  if (existsSync(packagesDir)) {
    for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const output of REBUILDABLE_PACKAGE_OUTPUTS) {
        const candidate = join(packagesDir, entry.name, output);
        if (existsSync(candidate)) dirs.push(candidate);
      }
    }
  }
  return dirs;
}

async function report(worktrees) {
  const freeKiB = await freeSpaceKiB();
  const freeGB = freeKiB / 1024 / 1024;
  const nodeModules = worktrees.map((worktree) => join(worktree.path, "node_modules"));
  const [totals, deps] = await Promise.all([
    sizesKiB(worktrees.map((worktree) => worktree.path)),
    sizesKiB(nodeModules),
  ]);

  console.log(
    `磁盘剩余：${formatKiB(freeKiB)}（警戒 ${WARN_FREE_GB} GB，危险 ${CRITICAL_FREE_GB} GB）\n`,
  );
  for (const worktree of worktrees) {
    const [dirtyOut, lastCommit] = await Promise.all([
      run("git", ["-C", worktree.path, "status", "--porcelain"]),
      run("git", ["-C", worktree.path, "log", "-1", "--format=%cr"]),
    ]);
    const dirty = dirtyOut.split("\n").filter(Boolean).length;
    const depsKiB = deps.get(join(worktree.path, "node_modules"));
    const tags = [
      worktree.isMain && "主检出",
      worktree.isCurrent && "当前",
      depsKiB === undefined ? "冷存" : `依赖 ${formatKiB(depsKiB)}`,
    ].filter(Boolean);
    console.log(
      `${basename(worktree.path)}  [${worktree.branch}]  ${formatKiB(totals.get(worktree.path))}`,
    );
    console.log(
      `  ${tags.join(" · ")} · 最近提交 ${lastCommit.trim() || "?"} · 未提交改动 ${dirty}`,
    );
  }

  const linked = worktrees.filter((worktree) => !worktree.isMain);
  const installed = linked.filter((worktree) => deps.has(join(worktree.path, "node_modules")));
  console.log(
    `\n链接 worktree：${linked.length} 个（上限 ${MAX_LINKED}），其中 ${installed.length} 个已安装依赖。`,
  );
  console.log("注：du 不识别 APFS 克隆共享的块，实际可释放空间可能低于上面的数字。");
  if (linked.length > MAX_LINKED) {
    console.log(
      `⚠ 超出上限：先用 \`git worktree remove <路径>\` 移除已完成的，或复用空闲 worktree，再新建。`,
    );
  }
  if (freeGB < WARN_FREE_GB) {
    console.log(
      `${freeGB < CRITICAL_FREE_GB ? "⛔" : "⚠"} 磁盘剩余不足 ${WARN_FREE_GB} GB：冷存暂停的 worktree：pnpm worktrees:cold <名称>`,
    );
  }
}

async function cold(worktrees) {
  const linked = worktrees.filter((worktree) => !worktree.isMain);
  const selected = coldAll
    ? linked.filter((worktree) => !worktree.isCurrent)
    : coldTargets.map((target) => {
        const match = worktrees.find(
          (worktree) => worktree.path === resolve(target) || basename(worktree.path) === target,
        );
        if (!match) {
          console.error(`不是本仓库的 worktree：${target}（可用名称见 pnpm worktrees:report）`);
          process.exit(1);
        }
        return match;
      });
  if (selected.length === 0) {
    console.log("没有指定要冷存的 worktree。用法：--cold <名称|路径>... 或 --cold --all");
    return;
  }

  const before = await freeSpaceKiB();
  for (const worktree of selected) {
    const name = basename(worktree.path);
    if (worktree.isMain || worktree.isCurrent) {
      console.log(`跳过 ${name}：主检出与当前 worktree 不冷存。`);
      continue;
    }
    const users = await processesUsing(worktree.path);
    if (users.length > 0) {
      console.log(
        `跳过 ${name}：仍有进程在使用（先停止 dev server/agent）：\n  ${users.slice(0, 3).join("\n  ")}`,
      );
      continue;
    }
    const dirs = await rebuildableDirs(worktree.path);
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true });
    }
    console.log(
      `已冷存 ${name}：删除 ${dirs.length} 个依赖/构建目录。恢复：cd ${worktree.path} && pnpm install`,
    );
  }
  const freedKiB = (await freeSpaceKiB()) - before;
  console.log(
    `\n释放约 ${formatKiB(Math.max(freedKiB, 0))}，当前剩余 ${formatKiB(await freeSpaceKiB())}。`,
  );
}

const worktrees = await listWorktrees();
if (coldMode) {
  await cold(worktrees);
} else {
  await report(worktrees);
}
