/**
 * Shared status-card surface for the Model Settings detail pane.
 *
 * Extracted from the Coding Plan status card so the Connected accounts screens can reuse the
 * exact same surface language (radius, border, background) instead of inventing a second
 * one. This is presentation only: callers own the meaning of `statusMeta` and actions.
 */
import type { ReactNode } from "react";

export function StatusCardSurface({
  title,
  titleAccessory,
  statusMeta,
  trailingAction,
  children,
}: {
  title: string;
  titleAccessory?: ReactNode;
  statusMeta: ReactNode;
  trailingAction?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex min-w-0 items-center justify-between gap-3 max-sm:flex-col max-sm:items-stretch">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            <h3 className="min-w-0 truncate text-ui-lg font-semibold leading-5 text-foreground">
              {title}
            </h3>
            {titleAccessory}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {statusMeta}
          </div>
        </div>
        {trailingAction ? (
          <div className="shrink-0 max-sm:flex max-sm:w-full max-sm:[&>button]:w-full">
            {trailingAction}
          </div>
        ) : null}
      </div>
      {children ? (
        <>
          <div className="my-4 border-t border-border" />
          {children}
        </>
      ) : null}
    </div>
  );
}
