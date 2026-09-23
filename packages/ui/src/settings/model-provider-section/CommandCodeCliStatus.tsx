/**
 * Command Code CLI account status, rendered inside the Command Code provider detail.
 *
 * WHY THIS LIVES HERE
 * "Command Code" used to appear twice in Model Settings: once as a real personal model
 * provider (`command-code`, seeded into the personal provider config by
 * `officialProviderMetadataImporter`) and once as a Command Code card inside the accounts
 * screen, which read the separate `commandcode status --json` CLI surface. Same brand, two
 * unrelated registries, so the same name looked like a duplicated provider/account.
 *
 * The provider is where Command Code is configured, so its CLI account status is presented
 * here as a compact strip next to that configuration. That leaves exactly one Command Code
 * presence in Model Settings.
 *
 * Plan and usage metrics are deliberately absent: the CLI exposes them only through its
 * interactive `/usage` overlay, which refuses to run headlessly. No figure is inferred.
 */
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useCommandCodeStatus } from "@/hooks/useCommandCodeStatus.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { StatusDot } from "@/settings/StatusDot.js";

/** Personal provider id of the Command Code Provider API integration. */
export const COMMAND_CODE_PROVIDER_ID = "command-code";

export function CommandCodeCliStatus() {
  const { intl } = useZCodeIntl();
  const { status, loading, refresh } = useCommandCodeStatus();

  if (loading && !status) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-surface p-4 text-ui-base text-foreground-subtle">
        <Loader2Icon className="size-4 animate-spin" />
        <span>{intl.formatMessage({ id: "common.loading" })}</span>
      </div>
    );
  }

  const installed = status?.installed === true;
  const authenticated = status?.authenticated === true;
  // status 为 null 只可能是这次读取本身失败（未安装由适配器以 installed:false 表达）。
  // 读取失败不能报成“未安装”，那是一个没有依据的结论。
  const statusUnavailable = status === null;
  const tone = statusUnavailable ? "subtle" : !installed ? "subtle" : authenticated ? "green" : "amber";

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.modelProvider.commandCodeCli.title" })}
          </h3>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-ui-base text-foreground-subtle">
            <StatusDot tone={tone} />
            <span>
              {intl.formatMessage({
                id: statusUnavailable
                  ? "settings.modelProvider.commandCodeCli.statusUnavailable"
                  : !installed
                    ? "settings.modelProvider.commandCodeCli.notInstalled"
                    : authenticated
                      ? "settings.modelProvider.commandCodeCli.authenticated"
                      : "settings.modelProvider.commandCodeCli.signedOut",
              })}
            </span>
            {status?.user ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 truncate text-foreground">{status.user}</span>
              </>
            ) : null}
            {status?.version ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono text-ui-sm text-foreground-subtlest">
                  {status.version}
                </span>
              </>
            ) : null}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={intl.formatMessage({
            id: "settings.modelProvider.commandCodeCli.refresh",
          })}
          disabled={loading}
          onClick={() => void refresh()}
        >
          {loading ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
        </Button>
      </div>
      <p className="mt-2 text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.modelProvider.commandCodeCli.usageUnavailable" })}
      </p>
    </div>
  );
}
