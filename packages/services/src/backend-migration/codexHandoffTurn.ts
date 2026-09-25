// Codex handoff turn 的固定 prompt 模板、就绪信号解析、意外 tool 活动检测（phase 11）。
// 见 backend-migration.md「zcode → codex」一节：thread/start 不接受任何种子参数，
// 唯一把上下文放到 Codex 面前的办法是一次真实的 turn/start——这个文件负责把那次真实的轮
// 约束到「只做上下文交接」，并且在它偏离约束时能被检测出来，而不是被当成正常 handoff 接受。
import {
  BACKEND_HANDOFF_READY_MARKER,
  type BackendHandoffEntry,
  type BackendHandoffTranscript,
} from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

function formatHandoffEntry(entry: BackendHandoffEntry): string {
  const label =
    entry.role === "user"
      ? "User"
      : entry.role === "assistant"
        ? "Assistant"
        : entry.role === "tool_summary"
          ? "Action"
          : "Note";
  return `${label}: ${entry.content}`;
}

/**
 * 固定模板，不是每次调用现拼字符串——文案本身就是产品契约的一部分（amendment 2），
 * 改措辞要像改任何其他 prompt 契约一样走审阅，不能散落在编排代码各处。
 */
export function buildCodexHandoffPrompt(transcript: BackendHandoffTranscript): string {
  const body = transcript.entries.map(formatHandoffEntry).join("\n");
  return [
    "This is a CONTEXT-TRANSFER turn, not a request to continue or redo the task yet.",
    "",
    "You are receiving the prior history of an existing task that is being handed to you from",
    "another backend. Read it for context only.",
    "",
    "Do NOT:",
    "- redo, continue, or re-attempt any part of the task in this turn",
    "- modify any files",
    "- run any tool or command, unless the protocol leaves you no other way to respond",
    "- summarize or repeat the transferred history back at length",
    "",
    `Reply with only a short acknowledgement that you are ready, including the exact token ` +
      `${BACKEND_HANDOFF_READY_MARKER} somewhere in your reply. Nothing else.`,
    "",
    "--- Prior task context ---",
    body,
    "--- End of prior task context ---",
  ].join("\n");
}

export interface CodexHandoffAcknowledgement {
  /** turn/start 达到了正常终态（非 error、非超时）。这是唯一的强制信号（amendment 2）。 */
  readonly reachedNormalTerminalState: boolean;
  /** 回复里是否出现了可识别的就绪标记——高置信度信号，但不是唯一判据，不据此单独失败。
   *  可省略：调用方如果还没解析回复文本（例如只想先判断轮本身有没有正常结束），
   *  省略它不影响判定结果，因为判定只看 reachedNormalTerminalState。 */
  readonly hasReadyMarker?: boolean;
}

/**
 * 判定 handoff turn 是否可以进入 commit：唯一的硬性条件是正常终态；
 * 就绪标记只影响置信度/日志，不能因为模型换了措辞而让一次工作正常的 handoff 判失败。
 */
export function isCodexHandoffAcknowledged(ack: CodexHandoffAcknowledgement): boolean {
  return ack.reachedNormalTerminalState;
}

export function parseCodexHandoffReply(replyText: string): { hasReadyMarker: boolean } {
  return { hasReadyMarker: replyText.includes(BACKEND_HANDOFF_READY_MARKER) };
}

/**
 * amendment 4：handoff turn 期间出现的任何 toolCall 行都是失败信号，不论 approvalPolicy
 * 能不能在协议层面机械拦住工具调用——协议层拦截是第一道防线（调用方在真正调用 turn/start
 * 前应该尽量把 approvalPolicy 收紧到不批准任何工具），这里是第二道、独立于协议实现细节的
 * 检测：只要投影里出现了属于这次 handoff turnId 的 toolCall 行，不论其 status，都判失败——
 * 一次「看起来正常结束」但动过文件/跑过命令的轮不是安全的 commit，即使 turn/start 本身
 * 返回的是正常终态。
 */
export function detectUnexpectedToolActivityInHandoffTurn(
  handoffTurnRows: readonly ConversationRow[],
): boolean {
  return handoffTurnRows.some((row) => row.kind === "toolCall");
}
