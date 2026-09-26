import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseClaudeNativeSessionFile,
  projectClaudeNativeSessionPreview,
} from "../src/session/claude-native/claudeNativeSessionImportParser.js";

test("Claude preview and imported transcript share visible user/assistant projection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-import-projection-"));
  const filePath = join(directory, "session.jsonl");
  const records = [
    {
      type: "user",
      timestamp: "2026-09-26T12:00:00Z",
      message: {
        role: "user",
        content:
          "# AGENTS.md instructions for /Users/example/AceVra\n<INSTRUCTIONS>private rules</INSTRUCTIONS>",
      },
    },
    {
      type: "user",
      timestamp: "2026-09-26T12:00:01Z",
      message: {
        role: "user",
        content: "<environment_context>private cwd</environment_context>Fix the routing issue",
      },
    },
    {
      type: "assistant",
      timestamp: "2026-09-26T12:00:02Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Read", input: { path: "private" } }],
      },
    },
    {
      type: "assistant",
      timestamp: "2026-09-26T12:00:03Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I’ll inspect the routing path." }],
      },
    },
    {
      type: "user",
      timestamp: "2026-09-26T12:00:04Z",
      message: { role: "user", content: "Also cover the retry case." },
    },
    {
      type: "assistant",
      timestamp: "2026-09-26T12:00:05Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The retry case is covered." }],
      },
    },
    {
      type: "assistant",
      isSidechain: true,
      message: { role: "assistant", content: [{ type: "text", text: "private subagent context" }] },
    },
  ];
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  try {
    const imported = await parseClaudeNativeSessionFile({
      filePath,
      workspacePath: "/example",
      sessionId: "fixture-session",
    });
    const preview = projectClaudeNativeSessionPreview(imported);
    assert.equal(preview.title, "Fix the routing issue");
    assert.deepEqual(preview.previewMessages, [
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
      preview.previewMessages,
      imported.messages.slice(0, 2).map(({ role, content }) => ({ role, content })),
    );
    assert.doesNotMatch(
      JSON.stringify({ preview, imported }),
      /AGENTS\.md|environment_context|private rules|private cwd|private subagent context|private"/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude files with only internal records fail visible import classification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-import-empty-"));
  const filePath = join(directory, "empty.jsonl");
  await writeFile(
    filePath,
    `${JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "bootstrap" } })}\n`,
  );
  try {
    await assert.rejects(
      parseClaudeNativeSessionFile({ filePath, workspacePath: "/example", sessionId: "empty" }),
      /没有可导入的可见消息/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
