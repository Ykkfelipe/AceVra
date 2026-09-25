// 后端迁移确认与进度对话框（backend-migration.md Amendment 4）。
//
// 这是「切到 Codex 要花一轮初始化」的成本透明入口：只陈述事实，不恐吓。确认后调用方
// 只发一个 switchTaskBackend 请求；对话框本身不持有任何权威状态——进行中/失败都来自
// Host 持久化的迁移结果与事件，rejected/inDoubt 各自有明确文案，不假装成功。
import { AlertCircleIcon, Loader2Icon } from "lucide-react";
import { testId, type SwitchTaskBackendResult, type ZCodeExecutionBackend } from "@zcode/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function BackendMigrationSwitchDialog({
  open,
  onOpenChange,
  to,
  from,
  switching,
  pendingPhase,
  result,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  to: ZCodeExecutionBackend;
  from: ZCodeExecutionBackend;
  /** 本窗口请求在途。 */
  switching: boolean;
  /** 持久化的在途阶段（任何窗口发起的都算）。 */
  pendingPhase: string | null;
  result: SwitchTaskBackendResult | null;
  onConfirm: () => void;
}) {
  const { intl } = useZCodeIntl();
  const busy = switching || pendingPhase !== null;
  const toLabel =
    to === "codex"
      ? intl.formatMessage({ id: "chat.toolbar.backend.codex.label" })
      : intl.formatMessage({ id: "chat.backendSwitch.agent" });
  const fromLabel =
    from === "codex"
      ? intl.formatMessage({ id: "chat.toolbar.backend.codex.label" })
      : intl.formatMessage({ id: "chat.backendSwitch.agent" });

  // 失败与拒绝分开展示：failed = 迁移尝试过并留下记录；rejected = 根本没开始。
  const failureMessage = (() => {
    if (!result) return null;
    if (result.outcome === "failed") {
      return intl.formatMessage(
        { id: "chat.backendSwitch.failed" },
        { backend: toLabel, origin: fromLabel },
      );
    }
    if (result.outcome === "inDoubt") {
      return intl.formatMessage({ id: "chat.backendSwitch.inDoubt" });
    }
    if (result.outcome === "rejected") {
      const key = (() => {
        switch (result.reason) {
          case "turn_in_progress":
            return "chat.backendSwitch.rejected.turnInProgress";
          case "concurrent_transition":
            return "chat.backendSwitch.rejected.concurrent";
          case "destination_unavailable":
            return "chat.backendSwitch.rejected.unavailable";
          default:
            return "chat.backendSwitch.rejected.unavailable";
        }
      })();
      return intl.formatMessage({ id: key }, { backend: toLabel });
    }
    return null;
  })();

  return (
    <AlertDialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <AlertDialogContent data-testid="v4-backend-migration-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {busy
              ? intl.formatMessage({ id: "chat.backendSwitch.inProgress" }, { backend: toLabel })
              : intl.formatMessage({ id: "chat.backendSwitch.codexConfirm.title" })}
          </AlertDialogTitle>
          {busy ? (
            <AlertDialogDescription className="flex items-center gap-2">
              <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
              <span>{intl.formatMessage({ id: "chat.backendTransition.contextTransferred" })}</span>
            </AlertDialogDescription>
          ) : failureMessage ? (
            <AlertDialogDescription className="flex items-start gap-2 text-destructive">
              <AlertCircleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span data-testid="v4-backend-migration-error">{failureMessage}</span>
            </AlertDialogDescription>
          ) : (
            <AlertDialogDescription>
              {intl.formatMessage({ id: "chat.backendSwitch.codexConfirm.description" })}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} data-testid="v4-backend-migration-cancel">
            {intl.formatMessage({ id: "common.cancel" })}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(event) => {
              // 迁移是多步事务：关闭对话框会丢掉进行中/失败的解释，按钮显式接管关闭。
              event.preventDefault();
              onConfirm();
            }}
            data-testid={testId("v4-backend-migration-confirm", to)}
          >
            {intl.formatMessage({ id: "chat.backendSwitch.codexConfirm.action" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
