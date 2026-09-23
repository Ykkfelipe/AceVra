/**
 * Settings → Model Settings → Connected accounts.
 *
 * One screen per external execution account (Codex, Claude Code). These are accounts this
 * harness hands work to, which is why they are not model providers: a provider configures a
 * model API or plan, an account is an authenticated external identity.
 *
 * Two concerns stay architecturally separate, as before:
 * - account connection (bridge status, connect / reconnect / disconnect)
 * - history import (works whether or not the account is connected)
 *
 * SECURITY: every value rendered here arrives from a sanitized host response. No OAuth token,
 * refresh token, `auth.json` content, Claude credential or Command Code API key is ever
 * transported to or rendered by this component. Codex's OAuth URL is opened by the host and
 * is deliberately not part of the response shape.
 *
 * The Claude history importer is REUSED from MigrationSection rather than reimplemented, and is
 * rendered as a sibling section so it keeps a single card level instead of nesting inside
 * another card.
 */
import type { AccountBridgeSource, AccountBridgeStatus } from "@zcode/shared";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { useAccountBridge } from "@/hooks/useAccountBridge.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatAccountPlanLabel,
  hasVerifiedSignIn,
  resolveAccountBridgeStatusView,
} from "@/settings/account-bridge/accountBridgePresentation.js";
import { CodexUsagePanel } from "@/settings/account-bridge/CodexUsagePanel.js";
import { MigrationSection } from "@/settings/MigrationSection.js";
import { StatusCardSurface } from "@/settings/StatusCardSurface.js";
import { StatusDot } from "@/settings/StatusDot.js";

interface AccountBridgeDetailProps {
  source: AccountBridgeSource;
  workspacePath: string | null;
  workspaceIdentity?: string;
  isDesktop?: boolean;
}

export function AccountBridgeDetail({
  source,
  workspacePath,
  workspaceIdentity,
  isDesktop,
}: AccountBridgeDetailProps) {
  const bridge = useAccountBridge();
  return (
    <AccountBridgeDetailView
      source={source}
      bridge={bridge}
      migrationSlot={
        <MigrationSection
          source={source === "codex" ? "codex" : "claude"}
          workspacePath={workspacePath}
          {...(workspaceIdentity ? { workspaceIdentity } : {})}
          {...(isDesktop === undefined ? {} : { isDesktop })}
        />
      }
    />
  );
}

/** Shared presentation boundary; fixtures pass deterministic bridge props and an inert slot. */
export function AccountBridgeDetailView({
  source,
  bridge,
  migrationSlot = null,
}: {
  source: AccountBridgeSource;
  bridge: ReturnType<typeof useAccountBridge>;
  migrationSlot?: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const {
    statusFor,
    busy,
    loading,
    refreshing,
    lastError,
    connect,
    reconnectBridge,
    disconnect,
    refreshStatuses,
  } = bridge;

  const status = statusFor(source);
  const isCodex = source === "codex";
  const title = intl.formatMessage({
    id: isCodex ? "settings.accounts.source.codex" : "settings.accounts.source.claudeCode",
  });
  const statusView = resolveAccountBridgeStatusView(status);
  const verifiedSignedIn = hasVerifiedSignIn(status) && status?.sourceSignedIn === true;
  const actionBusy = busy === source;

  const tokens = resolveStatusTokens({ status, intl });
  const canDisconnect = status?.state === "connected";
  const needsInstallHint = !loading && status?.installed === false;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({
            id: isCodex
              ? "settings.accounts.description.codex"
              : "settings.accounts.description.claudeCode",
          })}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={intl.formatMessage({ id: "settings.accounts.action.refresh" })}
          disabled={loading || refreshing || busy !== null}
          onClick={() => void refreshStatuses()}
        >
          {loading || refreshing ? (
            <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCwIcon className="size-3.5" aria-hidden="true" />
          )}
        </Button>
      </div>

      {lastError ? (
        <p
          role="alert"
          className="flex flex-wrap items-baseline gap-x-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-base"
        >
          <span>{intl.formatMessage({ id: `settings.accounts.error.${lastError.code}` })}</span>
          {lastError.reason ? (
            // 宿主已清洗过路径 / URL / 长串凭据；这里只作为诊断文本弱展示。
            <span className="font-mono text-ui-sm text-foreground-subtle">{lastError.reason}</span>
          ) : null}
        </p>
      ) : null}

      <StatusCardSurface
        title={title}
        statusMeta={
          <StatusMetaLine
            tokens={[
              <StatusDot
                key="state"
                tone={statusView.tone}
                {...(statusView.spinning ? { spinning: true } : {})}
              />,
              <span key="state-label">{intl.formatMessage({ id: statusView.labelId })}</span>,
              ...tokens,
            ]}
          />
        }
        trailingAction={
          <Button
            type="button"
            size="lg"
            disabled={loading || busy !== null || status?.installed === false}
            onClick={() => void connect(source)}
          >
            {actionBusy ? (
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
            ) : null}
            {intl.formatMessage({
              id: verifiedSignedIn
                ? "settings.accounts.action.reconnect"
                : "settings.accounts.action.connect",
            })}
          </Button>
        }
      >
        {isCodex ? <CodexUsagePanel status={status} /> : <ClaudeUsageNote />}

        {needsInstallHint ? (
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({
              id: isCodex
                ? "settings.accounts.installHint.codex"
                : "settings.accounts.installHint.claudeCode",
            })}
          </p>
        ) : (
          // 窄设置窗口（<640px）下提示与维护动作改为一列；动作行自身允许换行，
          // 否则两个非收缩按钮会把详情面板撑出横向滚动。
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-3">
            <p className="min-w-0 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.accounts.disconnectHint" }, { source: title })}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {isCodex ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null || !status?.installed}
                  onClick={() => void reconnectBridge("codex")}
                >
                  {busy === "codex" ? (
                    <Loader2Icon className="size-3 animate-spin" aria-hidden="true" />
                  ) : null}
                  {intl.formatMessage({ id: "settings.accounts.action.restartBridge" })}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy !== null || !canDisconnect}
                onClick={() => void disconnect(source)}
              >
                {intl.formatMessage({ id: "settings.accounts.action.disconnect" })}
              </Button>
            </div>
          </div>
        )}
      </StatusCardSurface>

      {migrationSlot}
    </div>
  );
}

/**
 * The local Claude connection status has no usage fields. Describe that limitation narrowly
 * rather than making a universal claim about Claude's APIs or drawing invented quota figures.
 */
function ClaudeUsageNote() {
  const { intl } = useZCodeIntl();
  return (
    <p className="text-ui-base text-foreground-subtle">
      {intl.formatMessage({ id: "settings.accounts.usage.managedByClaude" })}
    </p>
  );
}

function StatusMetaLine({ tokens }: { tokens: ReactNode[] }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-ui-base text-foreground-subtle">
      {tokens.map((token, index) => (
        <span key={index} className="flex min-w-0 items-center gap-1.5">
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          {token}
        </span>
      ))}
    </span>
  );
}

/**
 * Build the status-line tokens.
 *
 * Sign-in is only stated when the host actually asked the source application: Codex reports a
 * placeholder while its app-server is not running, and presenting that placeholder as
 * "Signed out" would assert something the host never verified.
 */
function resolveStatusTokens({
  status,
  intl,
}: {
  status: AccountBridgeStatus | undefined;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
}): ReactNode[] {
  const tokens: ReactNode[] = [];
  if (hasVerifiedSignIn(status)) {
    tokens.push(
      <span key="auth">
        {intl.formatMessage({
          id: status?.sourceSignedIn
            ? "settings.accounts.auth.signedIn"
            : "settings.accounts.auth.signedOut",
        })}
      </span>,
    );
  }
  const email = status?.identity?.email?.trim();
  if (email) {
    tokens.push(
      <span key="email" className="min-w-0 truncate text-foreground">
        {email}
      </span>,
    );
  }
  const planLabel = formatAccountPlanLabel(status?.identity?.planType);
  if (planLabel) {
    tokens.push(<span key="plan">{planLabel}</span>);
  }
  const authMethod = status?.identity?.authMethod?.trim();
  if (authMethod) {
    tokens.push(<span key="authMethod">{authMethod}</span>);
  }
  const apiProvider = status?.identity?.apiProvider?.trim();
  if (apiProvider) {
    tokens.push(<span key="apiProvider">{apiProvider}</span>);
  }
  const version = status?.version?.trim();
  if (version) {
    tokens.push(
      <span key="version" className="font-mono text-ui-sm text-foreground-subtlest">
        {version}
      </span>,
    );
  }
  if (status?.state === "error" && status.error) {
    tokens.push(<span key="state-error">{status.error}</span>);
  }
  return tokens;
}
