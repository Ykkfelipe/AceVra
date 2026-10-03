/**
 * M2 Phase 1 — Personal Bot backing workspace 的启动契约。
 *
 * 覆盖 spec §13.2：
 * - Bot 目录在所有启动分支上都必须被创建（有持久化 session 的常见路径过去完全不 mkdir）；
 * - 它不是一个用户 workspace：不进 initialWorkspacePath / workspacePurpose / agentWarmupTargets；
 * - 创建失败只告警，不阻断启动。
 *
 * Run: TSX_TSCONFIG_PATH=packages/desktop/tsconfig.json mise exec -- node --import tsx --test packages/desktop/src/main/startupWorkspace.test.ts
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveStartupWindowBootstrap } from "./startupWorkspace.js";

async function withTempDir<T>(run: (base: string) => Promise<T>): Promise<T> {
  const base = await mkdtemp(path.join(tmpdir(), "acevra-startup-"));
  try {
    return await run(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

interface CapturedLog {
  info: unknown[][];
  warn: unknown[][];
}

function createLogger(): CapturedLog {
  return { info: [], warn: [] };
}

function loggerOf(captured: CapturedLog) {
  return {
    info: (...args: unknown[]) => captured.info.push(args),
    warn: (...args: unknown[]) => captured.warn.push(args),
  };
}

test("the Personal Bot workspace exists after startup but is not a user workspace", async () => {
  await withTempDir(async (base) => {
    const settingsFile = path.join(base, "setting.json");
    const projectDir = path.join(base, "project");
    const conversationWorkspaceDir = path.join(base, "workspace", "default");
    const personalBotWorkspaceDir = path.join(base, "workspace", "personal-bot");
    await mkdir(projectDir, { recursive: true });
    // 最常见的启动路径：已有持久化 session。这条分支过去不会创建任何 workspace 目录，
    // 所以 Bot 目录的创建不能挂在那些分支里面。
    await writeFile(
      settingsFile,
      JSON.stringify({
        lastWorkspaceSession: [{ kind: "local", workspacePath: projectDir }],
        lastActiveTabIndex: 0,
        recentProjects: [projectDir],
      }),
      "utf8",
    );

    const bootstrap = await resolveStartupWindowBootstrap({
      settingsFile,
      conversationWorkspaceDir,
      personalBotWorkspaceDir,
      logger: loggerOf(createLogger()),
    });

    assert.equal((await stat(personalBotWorkspaceDir)).isDirectory(), true);

    // Bot 目录不得泄漏进任何“用户 workspace”字段。
    assert.notEqual(bootstrap.initialWorkspacePath, personalBotWorkspaceDir);
    assert.equal(bootstrap.initialWorkspacePurpose, undefined);
    const warmupPaths = (bootstrap.agentWarmupTargets ?? []).map((target) => target.workspacePath);
    assert.deepEqual(warmupPaths, [projectDir]);
    assert.equal(warmupPaths.includes(personalBotWorkspaceDir), false);
  });
});

test("first launch still opens the conversation workspace and creates the Bot workspace", async () => {
  await withTempDir(async (base) => {
    const settingsFile = path.join(base, "setting.json");
    const conversationWorkspaceDir = path.join(base, "workspace", "default");
    const personalBotWorkspaceDir = path.join(base, "workspace", "personal-bot");

    const bootstrap = await resolveStartupWindowBootstrap({
      settingsFile,
      conversationWorkspaceDir,
      personalBotWorkspaceDir,
      logger: loggerOf(createLogger()),
    });

    // 既有首启行为不变。
    assert.equal(bootstrap.initialWorkspacePath, conversationWorkspaceDir);
    assert.equal(bootstrap.initialWorkspacePurpose, "conversation");
    assert.equal((await stat(conversationWorkspaceDir)).isDirectory(), true);

    assert.equal((await stat(personalBotWorkspaceDir)).isDirectory(), true);
    const warmupPaths = (bootstrap.agentWarmupTargets ?? []).map((target) => target.workspacePath);
    assert.deepEqual(warmupPaths, [conversationWorkspaceDir]);
    assert.equal(warmupPaths.includes(personalBotWorkspaceDir), false);
  });
});

test("an uncreatable Personal Bot workspace warns instead of blocking startup", async () => {
  await withTempDir(async (base) => {
    const settingsFile = path.join(base, "setting.json");
    const conversationWorkspaceDir = path.join(base, "workspace", "default");
    // 让 mkdir 必然失败：把文件当作父目录。
    const blocker = path.join(base, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    const personalBotWorkspaceDir = path.join(blocker, "personal-bot");
    const captured = createLogger();

    const bootstrap = await resolveStartupWindowBootstrap({
      settingsFile,
      conversationWorkspaceDir,
      personalBotWorkspaceDir,
      logger: loggerOf(captured),
    });

    // 启动必须继续，且失败被如实记录。
    assert.equal(bootstrap.initialWorkspacePath, conversationWorkspaceDir);
    assert.equal(
      captured.warn.some((entry) => String(entry[0]).includes("Personal Bot workspace")),
      true,
    );
  });
});
