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

test("Codex scan derives bounded previews only from sanitized visible messages", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zcode-codex-preview-"));
  const previousHome = process.env.CODEX_HOME;
  const sessionId = "00000000-0000-4000-8000-000000000010";
  const workspacePath = join(temp, "workspace");
  const filePath = join(temp, "sessions", "2026", "09", "23", `${sessionId}.jsonl`);
  const userText = `<script>alert("user")</script>${"u".repeat(260)}`;
  const assistantText = `<img src=x onerror="assistant()">${"a".repeat(260)}`;
  await mkdir(join(temp, "sessions", "2026", "09", "23"), { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  process.env.CODEX_HOME = temp;

  const records = [
    {
      type: "session_meta",
      payload: {
        session_id: sessionId,
        cwd: workspacePath,
        timestamp: "2026-09-23T12:00:00.000Z",
        cli_version: "1.0",
        metadata: { hidden_metadata: "must-not-preview" },
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-09-23T12:00:00.600Z",
      payload: { type: "user_message", message: "hidden injected user content" },
    },
    {
      type: "response_item",
      timestamp: "2026-09-23T12:00:00.700Z",
      payload: { type: "reasoning", summary: [{ text: "hidden reasoning" }] },
    },
    {
      type: "response_item",
      timestamp: "2026-09-23T12:00:00.800Z",
      payload: { type: "function_call", name: "shell", arguments: "hidden tool call" },
    },
    {
      type: "response_item",
      timestamp: "2026-09-23T12:00:00.900Z",
      payload: { type: "function_call_output", output: "hidden tool result" },
    },
    {
      type: "response_item",
      timestamp: "2026-09-23T12:00:01.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: userText }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-09-23T12:00:02.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: assistantText }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-09-23T12:00:03.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "second visible user" }],
      },
    },
  ];
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  try {
    const [candidate] = await scanCodexImportableSessions({ limit: 1 });
    assert.ok(candidate);
    assert.equal(candidate.previewTitle, `${userText.slice(0, 50)}...`);
    assert.deepEqual(
      candidate.previewMessages?.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.match(candidate.previewMessages?.[0]?.content ?? "", /^<script>/u);
    assert.match(candidate.previewMessages?.[1]?.content ?? "", /^<img /u);
    for (const message of candidate.previewMessages ?? []) {
      assert.ok([...message.content].length <= 240);
      assert.match(message.content, /\.\.\.$/u);
    }

    const serializedCandidate = JSON.stringify(candidate);
    assert.doesNotMatch(
      serializedCandidate,
      /hidden reasoning|hidden tool call|hidden tool result|hidden_metadata|hidden injected user content/u,
    );

    const parsed = await parseCodexRollout(filePath);
    assert.equal(parsed?.messages.length, 3);
    assert.equal(parsed?.messages[0]?.content, userText);
    assert.equal(parsed?.messages[1]?.content, assistantText);
    assert.equal(parsed?.messages[2]?.content, "second visible user");
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
});

test("Codex scan keeps missing previews bounded and deduplicates fork files by newest activity", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zcode-codex-preview-fork-"));
  const previousHome = process.env.CODEX_HOME;
  const workspacePath = join(temp, "workspace");
  const missingSessionId = "00000000-0000-4000-8000-000000000011";
  const malformedSessionId = "00000000-0000-4000-8000-000000000013";
  const forkSessionId = "00000000-0000-4000-8000-000000000012";
  const sessionsDir = join(temp, "sessions", "2026", "09", "23");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  process.env.CODEX_HOME = temp;

  const header = (sessionId: string, timestamp: string) => ({
    type: "session_meta",
    payload: { session_id: sessionId, cwd: workspacePath, timestamp },
  });
  const missingPath = join(sessionsDir, `${missingSessionId}.jsonl`);
  const malformedPath = join(sessionsDir, "malformed.jsonl");
  const olderForkPath = join(sessionsDir, "older-fork.jsonl");
  const newerForkPath = join(sessionsDir, "newer-fork.jsonl");
  const invalidHeaderPath = join(sessionsDir, "invalid-header.jsonl");

  await writeFile(
    missingPath,
    `${JSON.stringify(header(missingSessionId, "2026-09-23T12:00:00.000Z"))}\n`,
  );
  await writeFile(
    malformedPath,
    `${[
      JSON.stringify(header(malformedSessionId, "2026-09-23T12:01:00.000Z")),
      "{not-json",
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "valid after malformed line" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "assistant after malformed line" }],
        },
      }),
    ].join("\n")}\n`,
  );
  await writeFile(
    olderForkPath,
    `${[
      JSON.stringify(header(forkSessionId, "2026-09-23T12:02:00.000Z")),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "older fork" }],
        },
      }),
    ].join("\n")}\n`,
  );
  await writeFile(
    newerForkPath,
    `${[
      JSON.stringify(header(forkSessionId, "2026-09-23T12:03:00.000Z")),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "newest fork" }],
        },
      }),
    ].join("\n")}\n`,
  );
  await writeFile(invalidHeaderPath, "not-json\n");
  await utimes(
    olderForkPath,
    new Date("2026-09-23T12:02:00.000Z"),
    new Date("2026-09-23T12:02:00.000Z"),
  );
  await utimes(
    newerForkPath,
    new Date("2026-09-23T12:03:00.000Z"),
    new Date("2026-09-23T12:03:00.000Z"),
  );
  await utimes(
    missingPath,
    new Date("2026-09-23T12:00:00.000Z"),
    new Date("2026-09-23T12:00:00.000Z"),
  );
  await utimes(
    malformedPath,
    new Date("2026-09-23T12:01:00.000Z"),
    new Date("2026-09-23T12:01:00.000Z"),
  );

  try {
    const scanned = await scanCodexImportableSessions();
    assert.equal(
      scanned.some((candidate) => candidate.sourcePath === invalidHeaderPath),
      false,
    );

    assert.equal(
      scanned.some((candidate) => candidate.sourcePath === missingPath),
      false,
    );
    const malformed = scanned.find((candidate) => candidate.sourcePath === malformedPath);
    assert.deepEqual(malformed?.previewMessages, [
      { role: "user", content: "valid after malformed line" },
      { role: "assistant", content: "assistant after malformed line" },
    ]);

    const forks = scanned.filter((candidate) => candidate.sessionId === forkSessionId);
    assert.equal(forks.length, 1);
    assert.equal(forks[0]?.sourcePath, newerForkPath);
    assert.deepEqual(forks[0]?.previewMessages, [{ role: "user", content: "newest fork" }]);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
});

test("Codex selects the parent conversation over a newer guardian rollout and orders by visible activity", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zcode-codex-guardian-"));
  const previousHome = process.env.CODEX_HOME;
  const workspacePath = join(temp, "workspace");
  const sessionId = "00000000-0000-4000-8000-000000000021";
  const guardianId = "00000000-0000-4000-8000-000000000022";
  const otherId = "00000000-0000-4000-8000-000000000023";
  const sessionsDir = join(temp, "sessions", "2026", "09", "26");
  const parentPath = join(sessionsDir, "parent.jsonl");
  const guardianPath = join(sessionsDir, "guardian.jsonl");
  const otherPath = join(sessionsDir, "other.jsonl");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  process.env.CODEX_HOME = temp;

  const message = (role: "user" | "assistant", text: string, timestamp: string) => ({
    type: "response_item",
    timestamp,
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  });
  const writeRollout = async (path: string, records: unknown[]) => {
    await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  };
  await writeRollout(parentPath, [
    {
      type: "session_meta",
      payload: {
        id: sessionId,
        session_id: sessionId,
        cwd: workspacePath,
        timestamp: "2026-09-26T12:00:00Z",
        source: "vscode",
        thread_source: "user",
      },
    },
    message("user", "Design a mall game", "2026-09-26T12:00:01Z"),
    message("assistant", "Start with the player loop.", "2026-09-26T12:00:02Z"),
    message("user", "Add social spaces.", "2026-09-26T12:05:00Z"),
    message("assistant", "Add a central plaza.", "2026-09-26T12:06:00Z"),
  ]);
  await writeRollout(guardianPath, [
    {
      type: "session_meta",
      payload: {
        id: guardianId,
        session_id: sessionId,
        parent_thread_id: sessionId,
        cwd: workspacePath,
        timestamp: "2026-09-26T12:07:00Z",
        source: { subagent: { other: "guardian" } },
        thread_source: "guardian_review",
      },
    },
    message("user", "Review the parent agent history.", "2026-09-26T12:08:00Z"),
    message("assistant", "Review complete.", "2026-09-26T12:09:00Z"),
  ]);
  await writeRollout(otherPath, [
    {
      type: "session_meta",
      payload: {
        id: otherId,
        session_id: otherId,
        cwd: workspacePath,
        timestamp: "2026-09-26T12:20:00Z",
      },
    },
    message("user", "A later conversation", "2026-09-26T12:30:00Z"),
  ]);
  await utimes(parentPath, new Date("2026-09-26T14:00:00Z"), new Date("2026-09-26T14:00:00Z"));
  await utimes(guardianPath, new Date("2026-09-26T15:00:00Z"), new Date("2026-09-26T15:00:00Z"));
  await utimes(otherPath, new Date("2026-09-26T10:00:00Z"), new Date("2026-09-26T10:00:00Z"));

  try {
    const candidates = await scanCodexImportableSessions({ codexHome: temp });
    assert.equal(candidates.length, 2);
    assert.deepEqual(
      candidates.map((candidate) => candidate.sessionId),
      [otherId, sessionId],
    );
    const candidate = candidates[1];
    assert.equal(candidate?.sourcePath, parentPath);
    assert.equal(candidate?.previewTitle, "Design a mall game");
    assert.deepEqual(candidate?.previewMessages, [
      { role: "user", content: "Design a mall game" },
      { role: "assistant", content: "Start with the player loop." },
    ]);
    assert.equal(candidate?.updatedAt, Date.parse("2026-09-26T12:06:00Z"));
    assert.deepEqual(
      (await scanCodexImportableSessions({ codexHome: temp, limit: 1 })).map(
        (item) => item.sessionId,
      ),
      [otherId],
    );
    assert.deepEqual(
      (
        await scanCodexImportableSessions({
          codexHome: temp,
          modifiedSince: Date.parse("2026-09-26T12:20:00Z"),
        })
      ).map((item) => item.sessionId),
      [otherId],
    );

    const tasks = new Map<
      string,
      { taskId: string; workspacePath: string; migrationSourceSessionId: string }
    >();
    let created = 0;
    const importOnce = () =>
      importCodexNativeSessions({
        taskIndexRepo: {
          getTaskMeta: async ({ taskId }: { taskId: string }) => tasks.get(taskId) ?? null,
        } as never,
        workspacePath,
        codexHome: temp,
        sessionIds: [sessionId],
        createImportedSession: async (source) => {
          created += 1;
          assert.equal(source.sessionId, sessionId);
          assert.deepEqual(
            source.messages.map(({ role, content }) => ({ role, content })),
            [
              { role: "user", content: "Design a mall game" },
              { role: "assistant", content: "Start with the player loop." },
              { role: "user", content: "Add social spaces." },
              { role: "assistant", content: "Add a central plaza." },
            ],
          );
          const taskId = buildImportedCodexTaskId(workspacePath, source.sessionId);
          const meta = { taskId, workspacePath, migrationSourceSessionId: sessionId };
          tasks.set(taskId, meta);
          return meta as never;
        },
        onTaskImported() {},
      });
    const first = await importOnce();
    const second = await importOnce();
    assert.equal(first.imported.length, 1);
    assert.equal(first.imported[0]?.taskId, buildImportedCodexTaskId(workspacePath, sessionId));
    assert.equal(second.skipped[0]?.reason, "already_imported");
    assert.equal(created, 1);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
});

test("Codex excludes injected project/context messages and shares preview with imported projection", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zcode-codex-context-"));
  const previousHome = process.env.CODEX_HOME;
  const sessionId = "00000000-0000-4000-8000-000000000014";
  const workspacePath = join(temp, "workspace");
  const sessionsDir = join(temp, "sessions", "2026", "09", "26");
  const filePath = join(sessionsDir, `${sessionId}.jsonl`);
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  process.env.CODEX_HOME = temp;
  const records = [
    {
      type: "session_meta",
      payload: { session_id: sessionId, cwd: workspacePath, timestamp: "2026-09-26T12:00:00Z" },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "# AGENTS.md instructions for /Users/example/AceVra\n<INSTRUCTIONS>private project rules</INSTRUCTIONS>\n<environment_context>private cwd data</environment_context>\nFix the routing issue",
          },
        ],
      },
    },
    {
      type: "response_item",
      payload: { type: "function_call", name: "shell", arguments: "private tool data" },
    },
    {
      type: "response_item",
      timestamp: "2026-09-26T12:00:04Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I’ll inspect the routing path." }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-09-26T12:00:05Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Also cover the retry case." }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-09-26T12:00:06Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "The retry case is covered." }],
      },
    },
  ];
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  try {
    const [candidate] = await scanCodexImportableSessions();
    const imported = await parseCodexRollout(filePath);
    assert.ok(candidate && imported);
    assert.equal(candidate.previewTitle, "Fix the routing issue");
    assert.deepEqual(candidate.previewMessages, [
      { role: "user", content: "Fix the routing issue" },
      { role: "assistant", content: "I’ll inspect the routing path." },
    ]);
    assert.deepEqual(
      imported.messages.map(({ role, content }) => ({ role, content })),
      [
        { role: "user", content: "Fix the routing issue" },
        { role: "assistant", content: "I’ll inspect the routing path." },
        { role: "user", content: "Also cover the retry case." },
        { role: "assistant", content: "The retry case is covered." },
      ],
    );
    assert.deepEqual(
      candidate.previewMessages,
      imported.messages.slice(0, 2).map(({ role, content }) => ({ role, content })),
    );
    assert.doesNotMatch(
      JSON.stringify({ candidate, imported }),
      /AGENTS\.md|environment_context|private tool data|private project rules/u,
    );
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
});

test("Codex rollout scan parses visible messages and import retries are idempotent", async () => {
  const temp = await mkdtemp(join(tmpdir(), "zcode-codex-history-"));
  const previousHome = process.env.CODEX_HOME;
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const workspaceIdentity = "remote:workspace-a";
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
    let importWorkspaceIdentity = workspaceIdentity;
    const createImportedSession = async (source: NonNullable<typeof parsed>) => {
      created += 1;
      assert.equal(source.sessionId, sessionId);
      assert.equal(source.createdAt, Date.parse("2026-09-23T12:00:00.000Z"));
      assert.equal(source.messages.length, 2);
      const taskId = buildImportedCodexTaskId(importWorkspaceIdentity, source.sessionId);
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
      workspacePath,
      workspaceIdentity,
      codexHome: temp,
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
      workspacePath,
      workspaceIdentity,
      codexHome: temp,
      sessionIds: [sessionId],
      createImportedSession,
      onTaskImported() {},
    });
    assert.equal(first.imported.length, 1);
    assert.equal(second.skipped[0]?.reason, "already_imported");
    assert.equal(created, 1);
    assert.equal(records.get(importedTaskId)?.migrationSourceSessionId, sessionId);

    importWorkspaceIdentity = "remote:workspace-b";
    const otherIdentity = await importCodexNativeSessions({
      taskIndexRepo,
      workspacePath,
      workspaceIdentity: importWorkspaceIdentity,
      codexHome: temp,
      sessionIds: [sessionId],
      createImportedSession,
      onTaskImported() {},
    });
    assert.equal(otherIdentity.imported.length, 1);
    assert.notEqual(otherIdentity.imported[0]?.taskId, importedTaskId);
    assert.equal(created, 2);

    const legacyTaskId = buildImportedCodexTaskId(workspacePath, sessionId);
    records.set(legacyTaskId, {
      taskId: legacyTaskId,
      workspacePath,
      migrationSource: "codex",
    });
    importWorkspaceIdentity = "remote:workspace-c";
    const legacyRetry = await importCodexNativeSessions({
      taskIndexRepo,
      workspacePath,
      workspaceIdentity: importWorkspaceIdentity,
      codexHome: temp,
      sessionIds: [sessionId],
      createImportedSession,
      onTaskImported() {},
    });
    assert.equal(legacyRetry.skipped[0]?.reason, "already_imported");
    assert.equal(created, 2);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
});
