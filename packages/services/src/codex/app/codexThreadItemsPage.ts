// thread/items/list 单页结果的容错解包（Codex app-server 返回形状随版本漂移）。
//
// 冷恢复重建（codexTaskRuntime）与迁移 handoff 轮取回（codexMigrationBridge）都要翻
// Codex 的历史页；把形状归一放在这里，两个调用方共享同一容错口径，避免各自猜测
// {items} / {data} / 裸数组。
export const MAX_HISTORY_PAGES = 50;

/** 解包一页 items：接受裸数组 / {items} / {data}，并取 nextCursor。 */
export function unwrapThreadItemsPage(result: unknown): {
  items: unknown[];
  nextCursor: string | null;
} {
  const record =
    typeof result === "object" && result !== null ? (result as Record<string, unknown>) : null;
  const items: unknown[] = Array.isArray(result)
    ? result
    : Array.isArray(record?.items)
      ? (record?.items as unknown[])
      : Array.isArray(record?.data)
        ? (record?.data as unknown[])
        : [];
  const next = record?.nextCursor;
  return { items, nextCursor: typeof next === "string" && next.trim() ? next : null };
}
