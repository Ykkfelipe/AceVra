/**
 * Codex 任务在工作区任务列表的可见性回归。
 *
 * 背景：zcode 任务列表按 provider='glm' 过滤；Codex 执行后端的任务行 provider 列
 * 不承载该语义（meta_json.executionBackend 才是标记）。若列表不过滤纳入，宿主重启后
 * Codex 任务会从任务列表消失，远端 /fork 无法重新打开该会话。
 *
 * Run: mise exec -- node --import tsx --test packages/services/test/codexTaskListVisibility.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

function baseMeta(overrides: Partial<ZCodeTaskMeta>): ZCodeTaskMeta {
  return {
    taskId: "task-x",
    traceId: "trace-x",
    workspacePath: "/example/workspace",
    title: "Example task",
    mode: "build",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

test("codex backend tasks stay visible in the workspace task list; imported history does not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-codex-list-"));
  setDataBaseDir(dir);
  try {
    const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
    const glm = baseMeta({
      taskId: "glm-1",
      title: "ZCode task",
      provider: "glm" as const,
    });
    const codex = baseMeta({
      taskId: "codex-1",
      title: "Codex task",
      executionBackend: "codex",
      codexThreadId: "thread-1",
    });
    const imported = baseMeta({
      taskId: "import-1",
      title: "Imported Claude session",
      migrationSource: "claudeCode" as const,
    });
    const importedCodex = baseMeta({
      taskId: "codex-import-1",
      title: "Imported Codex session",
      migrationSource: "codex" as const,
      migrationSourceSessionId: "synthetic-codex-session",
    });
    await repo.syncTaskMeta({ meta: glm });
    await repo.syncTaskMeta({ meta: codex });
    await repo.syncTaskMeta({ meta: imported });
    await repo.syncTaskMeta({ meta: importedCodex });
    // Runtime snapshots omit source provenance; the task-index owner must retain it.
    await repo.syncTaskMeta({
      meta: { ...importedCodex, migrationSource: undefined, migrationSourceSessionId: undefined },
    });

    // zcode 任务服务（provider='glm' 过滤）必须看到 glm + codex，看不到历史导入。
    const listed = await repo.listTaskMetas({
      workspacePath: "/example/workspace",
      provider: "glm" as const,
    });
    const ids = listed.map((meta) => meta.taskId).sort();
    assert.deepEqual(ids, ["codex-1", "glm-1"]);
    const codexMeta = listed.find((meta) => meta.taskId === "codex-1");
    assert.equal(codexMeta?.executionBackend, "codex");
    assert.equal(codexMeta?.codexThreadId, "thread-1");

    // 分页任务列表视图（queryTaskList）同款边界。
    const page = await repo.queryTaskList({
      workspaceScopes: [{ workspacePath: "/example/workspace" }],
      provider: "glm" as const,
    });
    assert.ok(page.items.some((meta) => meta.taskId === "codex-1"));

    // taskId-only 读取（宿主重启后 codex 路由探询/冷恢复只有 taskId）。
    const byIdOnly = await repo.getTaskMeta({ taskId: "codex-1" });
    assert.equal(byIdOnly?.executionBackend, "codex");
    assert.equal(byIdOnly?.workspacePath, "/example/workspace");
    const importedById = await repo.getTaskMeta({ taskId: "codex-import-1" });
    assert.equal(importedById?.migrationSource, "codex");
    assert.equal(importedById?.migrationSourceSessionId, "synthetic-codex-session");
    assert.equal(await repo.getTaskMeta({ taskId: "missing-id" }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
