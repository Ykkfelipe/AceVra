/**
 * Personal Bot M1 — 身份/档案、对话外壳、个人记忆有界检索、能力面。
 * 零推理、零真实进程；全部走临时目录 + 真实文件 store。
 *
 * Run: mise exec -- node --import tsx --test packages/services/test/personalBot.test.ts
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createNodeBotService } from "../src/bot/adapters/nodeBotService.js";
import { BotStoreCorruptError, isBotStoreCorruptError } from "../src/bot/contract.js";
import type { PersonalMemoryRecord } from "../src/bot/contract.js";
import {
  DEFAULT_MAX_MEMORY_RECORDS,
  MAX_MEMORY_CONTEXT_BYTES,
  renderPersonalMemoryContext,
  selectRelevantPersonalMemory,
} from "../src/bot/domain/memory.js";
import { BOT_CAPABILITY_DOMAINS } from "../src/bot/domain/capabilities.js";

async function withTempRoot<T>(
  run: (paths: { rootDir: string; workspacePath: string }) => Promise<T>,
): Promise<T> {
  const base = await mkdtemp(path.join(tmpdir(), "acevra-bot-"));
  const rootDir = path.join(base, "personal-bot");
  const workspacePath = path.join(base, "workspace", "personal-bot");
  try {
    return await run({ rootDir, workspacePath });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function makeService(paths: { rootDir: string; workspacePath: string }) {
  return createNodeBotService(paths);
}

function record(overrides: Partial<PersonalMemoryRecord> = {}): PersonalMemoryRecord {
  return {
    id: overrides.id ?? "mem_1",
    category: overrides.category ?? "preference",
    title: overrides.title ?? "Untitled",
    summary: overrides.summary ?? "",
    ...(overrides.details ? { details: overrides.details } : {}),
    tags: overrides.tags ?? [],
    pinned: overrides.pinned ?? false,
    source: overrides.source ?? "user",
    createdAt: overrides.createdAt ?? 1_000,
    updatedAt: overrides.updatedAt ?? 1_000,
  };
}

test("first read creates a persistent identity and profile", async () => {
  await withTempRoot(async (paths) => {
    const service = makeService(paths);
    const first = await service.getIdentity();
    assert.equal(first.profile.displayName, "Ace");
    assert.ok(first.identity.id.startsWith("bot_"));

    // 新实例读取同一数据根：身份必须稳定（身份与进程/对话无关）。
    const reopened = makeService(paths);
    const second = await reopened.getIdentity();
    assert.equal(second.identity.id, first.identity.id);
    assert.equal(second.identity.createdAt, first.identity.createdAt);
  });
});

test("profile edits never touch memory or the conversation pointer", async () => {
  await withTempRoot(async (paths) => {
    const service = makeService(paths);
    await service.getIdentity();
    await service.rememberMemory({
      category: "person",
      title: "Ada",
      summary: "Runs the design reviews",
    });
    await service.setConversationSession("sess_123");

    const before = await service.getIdentity();
    const updated = await service.updateProfile({
      displayName: "Nova",
      style: { tone: "direct" },
    });

    assert.equal(updated.profile.displayName, "Nova");
    assert.equal(updated.profile.style.tone, "direct");
    // 未给出的字段保持不变。
    assert.equal(updated.profile.style.verbosity, before.profile.style.verbosity);
    assert.equal(updated.identity.id, before.identity.id);

    // 记忆与对话指针不受档案编辑影响。
    assert.equal((await service.listMemory()).length, 1);
    assert.equal((await service.getConversationShell()).sessionId, "sess_123");
  });
});

test("conversation pointer is idempotent and clearing it keeps identity", async () => {
  await withTempRoot(async (paths) => {
    const service = makeService(paths);
    const created = await service.getConversationShell();
    assert.equal(created.sessionId, null);
    assert.equal(created.workspacePath, paths.workspacePath);

    const set = await service.setConversationSession("sess_a");
    assert.equal(set.sessionId, "sess_a");

    // 相同值重复设置不更新 updatedAt（幂等，不产生额外写入）。
    const again = await service.setConversationSession("sess_a");
    assert.equal(again.updatedAt, set.updatedAt);

    const cleared = await service.setConversationSession(null);
    assert.equal(cleared.sessionId, null);
    assert.equal(cleared.createdAt, created.createdAt);

    const identity = await service.getIdentity();
    assert.ok(identity.identity.id.startsWith("bot_"));
  });
});

test("missing documents fall back to defaults without error", async () => {
  await withTempRoot(async (paths) => {
    const service = makeService(paths);
    assert.deepEqual(await service.listMemory(), []);
    const shell = await service.getConversationShell();
    assert.equal(shell.sessionId, null);
  });
});

test("a corrupt memory document raises BotStoreCorruptError and is preserved", async () => {
  await withTempRoot(async (paths) => {
    const service = makeService(paths);
    await service.rememberMemory({ category: "goal", title: "Ship M1", summary: "" });
    const memoryPath = path.join(paths.rootDir, "memory.json");
    const original = await readFile(memoryPath, "utf8");

    await writeFile(memoryPath, "{ this is not json", "utf8");
    await assert.rejects(
      () => service.listMemory(),
      (error: unknown) => isBotStoreCorruptError(error) && error instanceof BotStoreCorruptError,
    );
    // 损坏文件不得被删除或覆盖：用户数据必须留在盘上。
    assert.equal(await readFile(memoryPath, "utf8"), "{ this is not json");

    await writeFile(memoryPath, original, "utf8");
    assert.equal((await service.listMemory()).length, 1);
  });
});

test("a memory document with a non-array records field is corrupt", async () => {
  await withTempRoot(async (paths) => {
    const service = makeService(paths);
    await mkdir(paths.rootDir, { recursive: true });
    await writeFile(
      path.join(paths.rootDir, "memory.json"),
      JSON.stringify({ version: 1, records: "nope" }),
      "utf8",
    );
    await assert.rejects(() => service.listMemory(), isBotStoreCorruptError);
  });
});

test("rememberMemory upserts by id and forgetMemory reports the outcome", async () => {
  await withTempRoot(async (paths) => {
    const service = makeService(paths);
    const created = await service.rememberMemory({
      category: "routine",
      title: "Morning walk",
      summary: "Before standup",
    });
    const updated = await service.rememberMemory({
      id: created.id,
      category: "routine",
      title: "Morning walk",
      summary: "Before standup, 20 minutes",
    });
    assert.equal(updated.id, created.id);
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal((await service.listMemory()).length, 1);

    assert.equal(await service.forgetMemory(created.id), true);
    assert.equal(await service.forgetMemory(created.id), false);
    assert.deepEqual(await service.listMemory(), []);
  });
});

test("bounded retrieval never dumps the store and reports omissions", async () => {
  await withTempRoot(async (paths) => {
    const service = makeService(paths);
    for (let index = 0; index < 200; index += 1) {
      await service.rememberMemory({
        category: "project",
        title: `Quarterly planning item ${index}`,
        summary:
          index === 0
            ? "Quarterly planning owner is Ada; quarterly planning review on Friday"
            : `Unrelated note number ${index}`,
      });
    }

    const context = await service.buildMemoryContext({ query: "quarterly planning" });
    assert.ok(context.selected.length > 0);
    assert.ok(
      context.selected.length <= DEFAULT_MAX_MEMORY_RECORDS,
      `expected <= ${DEFAULT_MAX_MEMORY_RECORDS} records, got ${context.selected.length}`,
    );
    assert.ok(
      Buffer.byteLength(context.text, "utf8") <= MAX_MEMORY_CONTEXT_BYTES,
      "rendered context must respect the byte cap",
    );
    assert.ok(context.omittedCount > 0, "omissions must be reported, not hidden");
    assert.ok(context.text.includes("omitted"));
  });
});

test("an empty query returns only pinned memory", () => {
  const records = [
    record({ id: "mem_pinned", title: "Always relevant", pinned: true }),
    record({ id: "mem_other", title: "Sometimes relevant" }),
  ];

  const selection = selectRelevantPersonalMemory(records, "");
  assert.deepEqual(
    selection.selected.map((entry) => entry.id),
    ["mem_pinned"],
  );
  assert.equal(selection.omittedCount, 0);
});

test("pinned records survive an unrelated query; unpinned ones must earn it", () => {
  const records = [
    record({ id: "mem_pinned", title: "Home address", pinned: true }),
    record({ id: "mem_relevant", title: "Deployment checklist", summary: "deploy steps" }),
    record({ id: "mem_noise", title: "Grocery list" }),
  ];

  const selection = selectRelevantPersonalMemory(records, "deploy");
  assert.deepEqual(
    selection.selected.map((entry) => entry.id),
    ["mem_pinned", "mem_relevant"],
  );
  assert.equal(selection.eligibleCount, 2);
});

test("rendered context truncates at a record boundary under a tight byte cap", () => {
  const records = Array.from({ length: 12 }, (_, index) =>
    record({
      id: `mem_${index}`,
      title: `预算复盘第 ${index} 次会议记录`,
      summary: "季度 预算 复盘 讨论 要点 " + "细".repeat(60),
    }),
  );

  const selection = selectRelevantPersonalMemory(records, "预算 复盘");
  const context = renderPersonalMemoryContext(selection, { maxBytes: 320 });

  assert.ok(Buffer.byteLength(context.text, "utf8") <= 320);
  assert.ok(context.selected.length < selection.selected.length);
  assert.ok(context.omittedCount > 0);
  // 截断必须落在记录边界：每个入选记录都完整出现。
  for (const entry of context.selected) {
    assert.ok(context.text.includes(entry.title), "record must not be cut mid-line");
  }
});

test("capability surface never claims an unavailable domain", async () => {
  await withTempRoot(async (paths) => {
    const service = makeService(paths);
    const surface = await service.listCapabilitySurface();
    assert.deepEqual(
      surface.entries.map((entry) => entry.domain),
      [...BOT_CAPABILITY_DOMAINS],
    );

    const byDomain = new Map(surface.entries.map((entry) => [entry.domain, entry]));
    assert.equal(byDomain.get("web")?.availability, "available");
    assert.equal(byDomain.get("files")?.availability, "available");
    // 没有实现的域必须如实呈现，不得因为路线图里有就标记 available。
    assert.equal(byDomain.get("email")?.availability, "not_configured");
    assert.equal(byDomain.get("calendar")?.availability, "not_configured");
    assert.equal(byDomain.get("devices")?.availability, "planned");

    // 后果性操作必须显式要求审批。
    assert.equal(byDomain.get("email")?.requiresApproval, true);
    assert.equal(byDomain.get("web")?.requiresApproval, false);
  });
});

test("documents are written separately so identity and conversation stay independent", async () => {
  await withTempRoot(async (paths) => {
    const service = makeService(paths);
    await service.getIdentity();
    await service.setConversationSession("sess_x");
    await service.rememberMemory({ category: "place", title: "Kyoto", summary: "" });

    const identity = JSON.parse(
      await readFile(path.join(paths.rootDir, "identity.json"), "utf8"),
    ) as Record<string, unknown>;
    const conversation = JSON.parse(
      await readFile(path.join(paths.rootDir, "conversation.json"), "utf8"),
    ) as Record<string, unknown>;
    const memory = JSON.parse(
      await readFile(path.join(paths.rootDir, "memory.json"), "utf8"),
    ) as Record<string, unknown>;

    assert.deepEqual(Object.keys(identity).sort(), ["identity", "profile", "version"]);
    assert.deepEqual(Object.keys(conversation).sort(), ["shell", "version"]);
    assert.deepEqual(Object.keys(memory).sort(), ["records", "version"]);
  });
});
