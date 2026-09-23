import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { after, before } from "node:test";
import { cleanupCodexTestIsolation, getIsolatedCodexHome } from "./codexTestIsolation.js";
import { zcodeSessionImportHistorySchema } from "@zcode/shared";
import { parseCodexRollout } from "../src/accounts/codexHistoryImportParser.js";
import { scanCodexImportableSessions } from "../src/accounts/codexHistoryImportRepo.js";
import {
  buildImportedCodexTaskId,
  importCodexNativeSessions,
} from "../src/accounts/codexNativeSessionImportService.js";

before(() => {
  process.env.CODEX_HOME = getIsolatedCodexHome();
});
after(cleanupCodexTestIsolation);

test("Codex rollout scan parses visible messages and import retries are idempotent", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zcode-codex-history-"));
  const previousHome = process.env.CODEX_HOME;
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const workspacePath = join(temp, "workspace");
  const filePath = join(temp, "sessions", "2026", "09", "23", `${sessionId}.jsonl`);
  const duplicateFilePath = join(temp, "sessions", "2026", "09", "22", `${sessionId}.jsonl`);
  await mkdir(join(temp, "sessions", "2026", "09", "23"), { recursive: true });
  await mkdir(join(temp, "sessions", "2026", "09", "22"), { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  process.env.CODEX_HOME = temp;
  const lines = [
    {
      type: "session_meta",
      payload: {
        session_id: sessionId,
        cwd: workspacePath,
        timestamp: "2026-09-23T12:00:00.000Z",
        cli_version: "1.0",
        model_provider: "openai",
      },
    },
    {
      type: "turn_context",
      timestamp: "2026-09-23T12:00:00.500Z",
      payload: { model: "gpt-5.6-sol", summary: "not imported" },
    },
    {
      type: "response_item",
      timestamp: "2026-09-23T12:00:01.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Summarize this task" }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-09-23T12:00:02.000Z",
      payload: { type: "function_call", name: "shell", arguments: "{}" },
    },
    {
      type: "response_item",
      timestamp: "2026-09-23T12:00:03.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Task summary" }],
      },
    },
  ];
  await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  await writeFile(duplicateFilePath, `${JSON.stringify(lines[0])}\n`, "utf8");
  await utimes(
    duplicateFilePath,
    new Date("2026-09-22T12:00:00.000Z"),
    new Date("2026-09-22T12:00:00.000Z"),
  );
  try {
    const scanned = await scanCodexImportableSessions({ limit: 10 });
    assert.equal(scanned.length, 1);
    assert.equal(scanned[0]?.sessionId, sessionId);
    assert.equal(scanned[0]?.sourcePath, filePath);
    const parsed = await parseCodexRollout(filePath);
    assert.equal(parsed?.messages.length, 2);
    assert.equal(parsed?.messages[0]?.content, "Summarize this task");
    assert.equal(parsed?.model, "gpt-5.6-sol");
    assert.equal(JSON.stringify(parsed).includes("token"), false);
    const importedHistory = zcodeSessionImportHistorySchema.parse({
      source: "codex",
      sourceSessionId: sessionId,
      model: parsed?.model,
      createdAt: parsed?.createdAt,
      updatedAt: parsed?.updatedAt,
      title: parsed?.title,
      messages: parsed?.messages,
    });
    assert.equal(importedHistory.sourceSessionId, sessionId);
    assert.throws(() =>
      zcodeSessionImportHistorySchema.parse({
        ...importedHistory,
        access_token: "must-not-be-imported",
      }),
    );

    const records = new Map<
      string,
      {
        taskId: string;
        workspacePath: string;
        migrationSource?: "codex";
        migrationSourceSessionId?: string;
      }
    >();
    const taskIndexRepo = {
      getTaskMeta: async ({ taskId }: { taskId: string }) => records.get(taskId) ?? null,
      syncTaskMeta: async ({
        meta,
      }: {
        meta: {
          taskId: string;
          workspacePath: string;
          migrationSource?: "codex";
          migrationSourceSessionId?: string;
        };
      }) => {
        records.set(meta.taskId, meta);
        return meta;
      },
    } as never;
    let created = 0;
    const createImportedSession = async (source: NonNullable<typeof parsed>) => {
      created += 1;
      assert.equal(source.sessionId, sessionId);
      assert.equal(source.createdAt, Date.parse("2026-09-23T12:00:00.000Z"));
      assert.equal(source.messages.length, 2);
      const taskId = buildImportedCodexTaskId(source.workspacePath, source.sessionId);
      const meta = {
        taskId,
        workspacePath: source.workspacePath,
        migrationSource: "codex",
      } as never;
      records.set(taskId, meta);
      return meta;
    };
    const first = await importCodexNativeSessions({
      taskIndexRepo,
      sessionIds: [sessionId],
      createImportedSession,
      onTaskImported() {},
    });
    const importedTaskId = first.imported[0]?.taskId;
    assert.ok(importedTaskId);
    // 模拟已有的旧任务只保存 migrationSource；重试补全来源 session ID，不新建任务。
    records.set(importedTaskId, {
      taskId: importedTaskId,
      workspacePath,
      migrationSource: "codex",
    });
    const second = await importCodexNativeSessions({
      taskIndexRepo,
      sessionIds: [sessionId],
      createImportedSession,
      onTaskImported() {},
    });
    assert.equal(first.imported.length, 1);
    assert.equal(second.skipped[0]?.reason, "already_imported");
    assert.equal(created, 1);
    assert.equal(records.get(importedTaskId)?.migrationSourceSessionId, sessionId);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
});
