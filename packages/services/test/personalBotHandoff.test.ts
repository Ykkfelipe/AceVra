/**
 * Personal Bot 的 Cross-Mode 采用点（仅限已发布契约层）。
 *
 * 覆盖 spec §13.6：
 * - Bot 对话引用符合冻结的 `handoffObjectRefSchema`（`kind: "conversation"`）；
 * - 没有对话 / 指针不合法时返回 null，调用方不得自行拼装；
 * - 引用里只有不透明 id，绝不携带个人记忆内容；
 * - Bot 侧不产生任何 handoff 准入记录或执行端口实现。
 *
 * Run: mise exec -- node --import tsx --test packages/services/test/personalBotHandoff.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  HANDOFF_OBJECT_KINDS,
  handoffObjectRefKey,
  handoffObjectRefSchema,
  handoffObjectIdSchema,
} from "@zcode/shared/cross-mode";
import { toBotConversationRef } from "../src/bot/domain/handoff.js";
import { createBotConversationShell } from "../src/bot/domain/shell.js";

const WORKSPACE = { path: "/tmp/personal-bot", key: "/tmp/personal-bot" };

function shellWith(sessionId: string | null) {
  return { ...createBotConversationShell({ workspace: WORKSPACE, now: 1_000 }), sessionId };
}

test("the Bot conversation reference conforms to the frozen cross-mode contract", () => {
  assert.ok(
    (HANDOFF_OBJECT_KINDS as readonly string[]).includes("conversation"),
    "the frozen contract must expose the conversation object kind",
  );

  const ref = toBotConversationRef(shellWith("sess_0f2a4c1e-1111-2222-3333-444455556666"));
  assert.ok(ref, "an active Bot conversation must produce a reference");

  // 用冻结契约自己的 schema 复验，而不是在测试里重写规则。
  assert.equal(handoffObjectRefSchema.safeParse(ref).success, true);
  assert.equal(ref.kind, "conversation");
  assert.equal(ref.id, "sess_0f2a4c1e-1111-2222-3333-444455556666");
  assert.equal(handoffObjectRefKey(ref), `conversation:${ref.id}`);
});

test("no conversation means no reference", () => {
  assert.equal(toBotConversationRef(shellWith(null)), null);
  assert.equal(toBotConversationRef(null), null);
  assert.equal(toBotConversationRef(undefined), null);
  // 空白 id 不是可引用会话。
  assert.equal(toBotConversationRef(shellWith("   ")), null);
});

test("a pointer that is not a valid contract id is refused, not repaired", () => {
  // 冻结契约的 id 字符集不允许空格 / 以连线开头。
  const invalid = " sess bad id ";
  assert.equal(handoffObjectIdSchema.safeParse(invalid.trim()).success, false);
  assert.equal(toBotConversationRef(shellWith(invalid)), null);
});

test("the reference carries only an opaque id — never personal memory", () => {
  const ref = toBotConversationRef(shellWith("sess_abc123"));
  assert.ok(ref);
  // 形状封闭：没有 summary/details/tags 之类会被误当成上下文搬运的字段。
  assert.deepEqual(Object.keys(ref).sort(), ["id", "kind"]);
});
