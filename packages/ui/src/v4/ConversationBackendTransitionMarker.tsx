// 执行后端迁移的时间线分隔线（backend-migration.md Amendment 4）。
//
// 行本身由时间线组合器按持久化的 backendTransitions 合成（不来自任何后端的行日志），所以
// 重启、Codex 冷恢复重排 rowId 之后仍在同一逻辑位置。Codex 方向可展开「Show handoff
// details」：按迁移下标向 Host 取回那次真实 handoff 轮的请求与回复（按 Codex turn id 定位），
// 默认折叠——它不是普通对话，也从不进入规范历史。
import { memo, useCallback, useState } from "react";
import { ArrowRightLeftIcon } from "lucide-react";
import { TID_V4_ROW, testId } from "@zcode/shared";
import type { ConversationRow, TimelineMarkerRow } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBackendTransitionSwitchedLabel } from "@/v4/backendTransitionMarkerLabel.js";

type BackendTransitionMarker = Extract<TimelineMarkerRow["marker"], { type: "backendTransition" }>;

function detailText(row: ConversationRow): string | null {
  if (row.kind === "userInput" || row.kind === "assistantText") return row.text;
  return null;
}

export const BackendTransitionMarkerRow = memo(function BackendTransitionMarkerRow({
  rowId,
  marker,
  modelSelectionView,
  loadHandoffDetails,
}: {
  rowId: number;
  marker: BackendTransitionMarker;
  modelSelectionView: ModelSelectionView | null;
  loadHandoffDetails?: (transitionIndex: number) => Promise<ConversationRow[] | null>;
}) {
  const { intl } = useZCodeIntl();
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState<ConversationRow[] | null | "loading">(null);
  const canShowDetails =
    marker.toBackend === "codex" &&
    marker.transitionIndex !== undefined &&
    Boolean(loadHandoffDetails);

  const toggleDetails = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    if (!next || details !== null || marker.transitionIndex === undefined || !loadHandoffDetails)
      return;
    setDetails("loading");
    void loadHandoffDetails(marker.transitionIndex).then((rows) => setDetails(rows ?? []));
  }, [details, expanded, loadHandoffDetails, marker.transitionIndex]);

  const switched = formatBackendTransitionSwitchedLabel(marker, modelSelectionView, intl);

  return (
    <div
      data-row-id={rowId}
      data-row-kind="timelineMarker"
      data-marker-type="backendTransition"
      data-status={marker.status}
      data-testid={testId(TID_V4_ROW, String(rowId))}
      className="flex w-full flex-col gap-1 px-4 py-2 text-ui-base text-[var(--color-foreground-subtle)]"
    >
      <div className="flex w-full items-center gap-3">
        <div aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
        <span className="inline-flex min-w-0 shrink flex-wrap items-center justify-center gap-x-1.5 text-center leading-5">
          <ArrowRightLeftIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{switched}</span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 break-words">
            {intl.formatMessage({ id: "chat.backendTransition.contextTransferred" })}
          </span>
          {canShowDetails ? (
            <button
              type="button"
              aria-expanded={expanded}
              data-testid={testId("v4-backend-transition-details-toggle", String(rowId))}
              onClick={toggleDetails}
              className="rounded-md px-1 text-ui-sm underline-offset-4 hover:text-[var(--color-foreground)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
            >
              {intl.formatMessage({
                id: expanded
                  ? "chat.backendTransition.hideDetails"
                  : "chat.backendTransition.showDetails",
              })}
            </button>
          ) : null}
        </span>
        <div aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
      </div>
      {expanded ? (
        <div
          data-testid={testId("v4-backend-transition-details", String(rowId))}
          className="mx-auto flex w-full max-w-3xl flex-col gap-2 rounded-lg border border-border bg-surface p-3 text-ui-sm"
        >
          {details === "loading" ? null : !details || details.length === 0 ? (
            <span>{intl.formatMessage({ id: "chat.backendTransition.detailsUnavailable" })}</span>
          ) : (
            details.map((row) => {
              const text = detailText(row);
              if (text === null) return null;
              return (
                <div key={row.rowId} className="flex flex-col gap-1">
                  <span className="text-ui-xs font-medium text-foreground-subtle">
                    {intl.formatMessage({
                      id:
                        row.kind === "userInput"
                          ? "chat.backendTransition.detailsRequest"
                          : "chat.backendTransition.detailsReply",
                    })}
                  </span>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-sm text-[var(--color-foreground)]">
                    {text}
                  </pre>
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
});
