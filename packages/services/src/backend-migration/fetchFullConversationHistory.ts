// 把 conversationRowsRangeV4（游标分页，单页上限 PROTOCOL_V4_LIMITS.rowsRangeMaxLimit）
// 走成完整历史。两个后端的 conversationRowsRangeV4 实现都要求目标 Runtime 已经能应答
// （Codex 会 resume/rebuild 投影；zcode 按 "start-if-needed" 策略可能拉起 zcode-cli）——
// 迁移读旧后端历史时这正是我们想要的：旧后端在迁移过程中必须保持可用、未被触碰。
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type {
  V4ConversationRowsRangeParams,
  V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";

export type ReadConversationRowsRange = (
  params: V4ConversationRowsRangeParams,
) => Promise<V4ConversationRowsRangeResult>;

export interface FetchFullConversationHistoryParams {
  readonly sessionId: string;
  readonly clientMode?: V4ConversationRowsRangeParams["clientMode"];
  readonly readRange: ReadConversationRowsRange;
  /** 单页大小；默认吃满协议上限，测试可以传小值验证分页拼接是否正确。 */
  readonly pageLimit?: number;
  /** 防御性上限：单次迁移最多翻多少页，避免一个异常长的会话把迁移拖到不可控。 */
  readonly maxPages?: number;
}

const DEFAULT_PAGE_LIMIT = 200; // PROTOCOL_V4_LIMITS.rowsRangeMaxLimit
const DEFAULT_MAX_PAGES = 200; // 200 页 × 200 行 = 4 万行的硬上限，超出即视为异常并报错

export class ConversationHistoryPagingLimitExceededError extends Error {
  constructor(
    readonly sessionId: string,
    readonly maxPages: number,
  ) {
    super(
      `会话 ${sessionId} 的历史翻页超过了 ${maxPages} 页上限，拒绝继续——` +
        "这通常意味着分页游标没有收敛，而不是会话真的这么长。",
    );
    this.name = "ConversationHistoryPagingLimitExceededError";
  }
}

/**
 * 从最新一页开始向旧翻页，直到 hasMore=false，再拼成 rowId 升序的完整历史。
 * 每一页本身已经是 rowId 升序（协议约定），页与页之间「更旧的页」整体排在前面。
 */
export async function fetchFullConversationHistory(
  params: FetchFullConversationHistoryParams,
): Promise<readonly ConversationRow[]> {
  const pageLimit = params.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const maxPages = params.maxPages ?? DEFAULT_MAX_PAGES;
  const pagesOldestFirst: (readonly ConversationRow[])[] = [];
  let beforeRowId: number | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= maxPages) {
      throw new ConversationHistoryPagingLimitExceededError(params.sessionId, maxPages);
    }
    const result = await params.readRange({
      sessionId: params.sessionId,
      ...(params.clientMode ? { clientMode: params.clientMode } : {}),
      ...(beforeRowId === undefined ? {} : { beforeRowId }),
      limit: pageLimit,
    });
    pagesOldestFirst.unshift(result.rows);
    if (!result.hasMore || result.rows.length === 0) break;
    beforeRowId = result.rows[0]!.rowId;
  }
  return pagesOldestFirst.flat();
}
