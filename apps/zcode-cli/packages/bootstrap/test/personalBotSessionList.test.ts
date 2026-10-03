/**
 * Bot 对话历史的 session/list 投影（docs/specs/personal-bot.md §16.3）。
 *
 * 证明：
 * - 缺省（task-list）列表的成员与改动前逐字一致，personal_bot 仍被排除；
 * - personal-bot 投影只返回 personal_bot，store 行与未落库的 live 记录同一规则过滤；
 * - 投影是闭合枚举：未知值、自由 taskTypes、缺 workspace 的 personal-bot 请求都被拒绝。
 *
 * 只有 session store / live 记录是假的，listSessions 本体走真实代码路径。
 *
 * Run (from apps/zcode-cli/packages/bootstrap, after pnpm build):
 *   mise exec -- node --import tsx --test test/personalBotSessionList.test.ts
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionInfo, SessionTaskType } from "@zcode/contracts";
import { zcodeSessionListParamsSchema } from "@zcode/shared";

import { listSessions } from "../src/zcode-protocol/server-operations.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import {
  isSessionInListProjection,
  sessionListProjectionTaskTypes,
} from "../src/zcode-protocol-v4/session-list-projection.js";
import { TASK_LIST_SESSION_TYPES } from "../src/zcode-protocol-v4/task-list-session-membership.js";

const BOT_WORKSPACE = "/tmp/zcode-test/workspace/personal-bot";
const CODING_WORKSPACE = "/tmp/zcode-test/projects/app";

function storedSession(input: {
  id: string;
  taskType: SessionTaskType;
  directory: string;
  title: string;
  updated: number;
}): SessionInfo {
  return {
    id: input.id,
    directory: input.directory,
    path: input.directory,
    title: input.title,
    titleSource: "generated",
    taskType: input.taskType,
    time: { created: input.updated - 1_000, updated: input.updated },
  } as unknown as SessionInfo;
}

function liveRecord(input: { id: string; taskType: SessionTaskType; workspace: string }) {
  return {
    persistence: "immediate",
    taskType: input.taskType,
    app: {
      sessionId: input.id,
      traceId: `trace-${input.id}`,
      getMode: () => "build",
      getModel: () => "",
    },
    workspace: { workspaceKey: input.workspace, workspacePath: input.workspace },
  };
}

function createContext() {
  const storeQueries: Array<{ taskTypes?: readonly string[]; directory?: string }> = [];
  const stored = [
    storedSession({
      id: "sess_bot_old",
      taskType: "personal_bot",
      directory: BOT_WORKSPACE,
      title: "Dinner ideas",
      updated: 1_000_000,
    }),
    storedSession({
      id: "sess_bot_new",
      taskType: "personal_bot",
      directory: BOT_WORKSPACE,
      title: "Trip plan",
      updated: 2_000_000,
    }),
    // 迁移前遗留：Bot workspace 里按 interactive 建的旧会话，不属于 Bot 历史。
    storedSession({
      id: "sess_legacy_interactive",
      taskType: "interactive",
      directory: BOT_WORKSPACE,
      title: "Asking what I am",
      updated: 500_000,
    }),
    storedSession({
      id: "sess_coding",
      taskType: "interactive",
      directory: CODING_WORKSPACE,
      title: "Fix login",
      updated: 3_000_000,
    }),
  ];
  const sessionStore = {
    listSessions: async (query: { taskTypes?: readonly string[]; directory?: string }) => {
      storeQueries.push(query);
      return stored.filter(
        (session) =>
          (!query.directory || session.directory === query.directory) &&
          (!query.taskTypes || query.taskTypes.includes(session.taskType ?? "interactive")),
      );
    },
    getSession: async () => null,
  };
  const sessions = new Map<string, unknown>([
    // 已发首条但尚未出现在 store 查询结果里的 Bot 会话（live-only）。
    [
      "sess_bot_live",
      liveRecord({ id: "sess_bot_live", taskType: "personal_bot", workspace: BOT_WORKSPACE }),
    ],
    // Bot workspace 里的 subagent child：任何投影都不得列出。
    [
      "sess_bot_child",
      liveRecord({ id: "sess_bot_child", taskType: "subagent_child", workspace: BOT_WORKSPACE }),
    ],
  ]);
  const context = {
    deps: { sessionStore },
    sessions,
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, storeQueries };
}

const botWorkspaceRef = { workspacePath: BOT_WORKSPACE, workspaceKey: BOT_WORKSPACE };

test("the default projection keeps the coding task-list membership unchanged", () => {
  assert.deepEqual(sessionListProjectionTaskTypes(undefined), [...TASK_LIST_SESSION_TYPES]);
  assert.deepEqual(sessionListProjectionTaskTypes("task-list"), [...TASK_LIST_SESSION_TYPES]);
  assert.equal(isSessionInListProjection(undefined, "personal_bot"), false);
  assert.equal(isSessionInListProjection("task-list", "personal_bot"), false);
  assert.equal(isSessionInListProjection(undefined, "interactive"), true);
});

test("the personal-bot projection admits only personal_bot sessions", () => {
  assert.deepEqual(sessionListProjectionTaskTypes("personal-bot"), ["personal_bot"]);
  assert.equal(isSessionInListProjection("personal-bot", "personal_bot"), true);
  for (const other of ["interactive", "fork", "workflow_parent", "subagent_child"] as const) {
    assert.equal(isSessionInListProjection("personal-bot", other), false, other);
  }
  // 缺省 taskType 视为 interactive，不能算作 Bot 会话。
  assert.equal(isSessionInListProjection("personal-bot", undefined), false);
});

test("listing the Bot workspace with personal-bot returns its conversations only", async () => {
  const { context, storeQueries } = createContext();
  const result = await listSessions(context, {
    workspace: botWorkspaceRef,
    projection: "personal-bot",
  });

  assert.deepEqual(storeQueries.at(-1)?.taskTypes, ["personal_bot"]);
  assert.deepEqual(result.sessions.map((session) => session.sessionId).sort(), [
    "sess_bot_live",
    "sess_bot_new",
    "sess_bot_old",
  ]);
  for (const session of result.sessions) {
    assert.equal(session.sessionKind, "personal_bot");
  }
  const trip = result.sessions.find((session) => session.sessionId === "sess_bot_new");
  assert.equal(trip?.title, "Trip plan");
  assert.equal(trip?.updatedAt, 2_000_000);
});

test("the default list of the Bot workspace still never shows Bot conversations", async () => {
  const { context, storeQueries } = createContext();
  const result = await listSessions(context, { workspace: botWorkspaceRef });

  assert.deepEqual(storeQueries.at(-1)?.taskTypes, [...TASK_LIST_SESSION_TYPES]);
  assert.deepEqual(
    result.sessions.map((session) => session.sessionId),
    ["sess_legacy_interactive"],
  );
});

test("the projection is a closed, workspace-scoped contract on the wire", () => {
  const schema = zcodeSessionListParamsSchema;
  assert.equal(
    schema.safeParse({ workspace: botWorkspaceRef, projection: "personal-bot" }).success,
    true,
  );
  assert.equal(schema.safeParse({ workspace: botWorkspaceRef }).success, true);
  // personal-bot 必须指定 workspace，避免跨 workspace 混列。
  assert.equal(schema.safeParse({ projection: "personal-bot" }).success, false);
  // 闭合枚举：未知投影与自由 taskTypes 都被拒绝。
  assert.equal(
    schema.safeParse({ workspace: botWorkspaceRef, projection: "subagent" }).success,
    false,
  );
  assert.equal(
    schema.safeParse({ workspace: botWorkspaceRef, taskTypes: ["subagent_child"] }).success,
    false,
  );
});
