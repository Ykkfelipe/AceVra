/**
 * Personal Bot 对话的 session 类型边界。
 *
 * 覆盖三件事：
 * - `personal_bot` 是合法持久化类型，但**不在** Coding Sessions 列表投影里；
 * - V4 createSession 只接受可创建类型（外部类型如 subagent_child 被拒绝）；
 * - Bot 对话仍被视为「正常对话」，因此仍然生成会话标题。
 *
 * Run: mise exec -- node --import tsx --test apps/zcode-cli/packages/bootstrap/test/personalBotSessionKind.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_TASK_TYPES, isConversationalSessionTaskType } from "@zcode/contracts";
import {
  zcodeCreatableSessionTaskTypes,
  zcodeSessionKindSchema,
} from "@zcode/shared";
import { commandPayloadSchemas } from "@zcode/shared/zcode-protocol-v4";

import {
  TASK_LIST_SESSION_TYPES,
  isTaskListSessionType,
} from "../src/zcode-protocol-v4/task-list-session-membership.js";

test("personal_bot is a persisted session type", () => {
  assert.ok((SESSION_TASK_TYPES as readonly string[]).includes("personal_bot"));
  assert.equal(zcodeSessionKindSchema.safeParse("personal_bot").success, true);
});

test("bot conversations stay out of the coding session list", () => {
  assert.equal(isTaskListSessionType("personal_bot"), false);
  assert.equal(
    (TASK_LIST_SESSION_TYPES as readonly string[]).includes("personal_bot"),
    false,
  );
  // 既有列表语义不变。
  assert.equal(isTaskListSessionType("interactive"), true);
  assert.equal(isTaskListSessionType(undefined), true);
});

test("bot conversations still behave like normal conversations for titles", () => {
  assert.equal(isConversationalSessionTaskType("personal_bot"), true);
  assert.equal(isConversationalSessionTaskType("interactive"), true);
  assert.equal(isConversationalSessionTaskType(undefined), true);
  // 内部派生的 child 类型仍不生成标题。
  assert.equal(isConversationalSessionTaskType("subagent_child"), false);
  assert.equal(isConversationalSessionTaskType("workflow_child"), false);
});

test("V4 createSession accepts personal_bot and rejects internal session kinds", () => {
  const schema = commandPayloadSchemas.createSession;

  assert.equal(
    schema.safeParse({ workspaceId: "/tmp/bot", taskType: "personal_bot" }).success,
    true,
  );
  assert.equal(schema.safeParse({ workspaceId: "/tmp/bot" }).success, true);
  // fork / subagent / workflow child 是宿主内部派生产物，外部不得指定。
  assert.equal(
    schema.safeParse({ workspaceId: "/tmp/bot", taskType: "subagent_child" }).success,
    false,
  );
  assert.equal(
    schema.safeParse({ workspaceId: "/tmp/bot", taskType: "workflow_parent" }).success,
    false,
  );

  assert.deepEqual([...zcodeCreatableSessionTaskTypes], ["personal_bot"]);
});
