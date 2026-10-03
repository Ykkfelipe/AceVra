import type { SessionTaskType } from "@zcode/contracts";
import type { ZCodeSessionListProjection } from "@zcode/shared";
import { TASK_LIST_SESSION_TYPES, isTaskListSessionType } from "./task-list-session-membership.js";

/**
 * session/list 的列表投影成员规则（docs/specs/personal-bot.md §16.3）。
 *
 * - `task-list`（缺省）沿用 TASK_LIST_SESSION_TYPES，Coding Sessions 语义逐字不变；
 * - `personal-bot` 只含 personal_bot：Bot 对话历史直接从 session store 派生，
 *   不复制一份 Bot 侧索引，也不放宽 sessions-index（它喂 host 的 Coding task index）。
 */
const PERSONAL_BOT_SESSION_TYPES = ["personal_bot"] as const satisfies readonly SessionTaskType[];

const DEFAULT_SESSION_LIST_PROJECTION: ZCodeSessionListProjection = "task-list";

export function resolveSessionListProjection(
  projection: ZCodeSessionListProjection | undefined,
): ZCodeSessionListProjection {
  return projection ?? DEFAULT_SESSION_LIST_PROJECTION;
}

/** store 查询用的 taskTypes；与 {@link isSessionInListProjection} 同源，避免两处成员规则分叉。 */
export function sessionListProjectionTaskTypes(
  projection: ZCodeSessionListProjection | undefined,
): SessionTaskType[] {
  return resolveSessionListProjection(projection) === "personal-bot"
    ? [...PERSONAL_BOT_SESSION_TYPES]
    : [...TASK_LIST_SESSION_TYPES];
}

/** live runtime 记录的成员判定（未落库的会话也要按同一投影过滤）。 */
export function isSessionInListProjection(
  projection: ZCodeSessionListProjection | undefined,
  taskType: SessionTaskType | undefined,
): boolean {
  if (resolveSessionListProjection(projection) === "personal-bot") {
    return taskType === "personal_bot";
  }
  return isTaskListSessionType(taskType);
}
