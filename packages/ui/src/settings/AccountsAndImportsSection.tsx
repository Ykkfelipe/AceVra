/**
 * Settings → Accounts & Imports.
 *
 * Renders sanitized account/usage state for the external coding agents this fork can
 * bridge to, plus history import entry points.
 *
 * Two concerns are kept architecturally separate on purpose:
 * - account connection (bridge status, connect / reconnect / disconnect)
 * - history import (works whether or not the account is connected)
 *
 * SECURITY: every value rendered here arrives from a sanitized host response. No OAuth
 * token, refresh token, `auth.json` content, Claude credential or Command Code API key is
 * ever transported to or rendered by this component. Codex's OAuth URL is opened by the
 * Mac host and is deliberately not part of the response shape.
 *
 * The Claude history importer is REUSED from MigrationSection rather than reimplemented.
 */
import type { AccountBridgeStatus } from "@zcode/shared";
import type { CommandCodeStatus } from "@zcode/services";
import { useAccountsAndImports } from "@/hooks/useAccountsAndImports.js";
import { MigrationSection } from "@/settings/MigrationSection.js";

function StateDot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  const color = ok ? "bg-success" : warn ? "bg-warning" : "bg-foreground-subtle";
  return <span className={`inline-block size-2 rounded-full ${color}`} aria-hidden="true" />;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-ui-xs text-foreground-subtle">{label}</span>
      <span className="text-ui-xs font-medium tabular-nums">{value}</span>
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-card-border bg-card p-4">
      <header className="mb-3">
        <h3 className="text-ui-sm font-semibold">{title}</h3>
        {subtitle ? <p className="mt-0.5 text-ui-xs text-foreground-subtle">{subtitle}</p> : null}
      </header>
      {children}
    </section>
  );
}

function bridgeStateLabel(status: AccountBridgeStatus | undefined): string {
  if (!status) return "unknown";
  if (!status.installed) return "not installed";
  switch (status.state) {
    case "connected":
      return "bridge running";
    case "connecting":
      return "connecting…";
    case "error":
      return `error${status.error ? `: ${status.error}` : ""}`;
    default:
      return "bridge stopped";
  }
}

export function AccountsAndImportsSection({
  workspacePath,
  workspaceIdentity,
  isDesktop,
}: {
  workspacePath: string | null;
  workspaceIdentity?: string;
  isDesktop?: boolean;
}) {
  const {
    statusFor,
    commandCode,
    codexCandidates,
    busy,
    loading,
    lastError,
    connect,
    reconnectBridge,
    disconnect,
    scanCodexHistory,
    refreshStatuses,
    refreshCommandCode,
  } = useAccountsAndImports();

  const codex = statusFor("codex");
  const claude = statusFor("claude-code");

  const actionButton = (
    label: string,
    onClick: () => void,
    opts: { disabled?: boolean; subtle?: boolean } = {},
  ) => (
    <button
      type="button"
      disabled={opts.disabled}
      onClick={onClick}
      className={
        opts.subtle
          ? "rounded-lg border border-border px-3 py-1.5 text-ui-xs text-foreground-subtle hover:bg-surface-hover disabled:opacity-50"
          : "rounded-lg bg-primary px-3 py-1.5 text-ui-xs text-primary-foreground hover:opacity-90 disabled:opacity-50"
      }
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-ui-base font-semibold">Accounts &amp; Imports</h2>
          <p className="text-ui-xs text-foreground-subtle">
            Connect external coding agents and import their history. Credentials stay on this
            Mac — this view only ever receives sanitized status.
          </p>
        </div>
        {actionButton("Refresh", () => {
          void refreshStatuses();
          void refreshCommandCode();
        }, { subtle: true, disabled: loading })}
      </div>

      {lastError ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-xs">
          {lastError}
        </p>
      ) : null}

      {/* ---------------------------------------------------------------- Codex */}
      <Card title="Codex" subtitle="ChatGPT-managed authentication via the Codex App Server">
        <Row label="Installed" value={codex?.installed ? (codex.version ?? "yes") : "no"} />
        <Row
          label="Bridge"
          value={
            <span className="inline-flex items-center gap-1.5">
              <StateDot ok={codex?.state === "connected"} warn={codex?.state === "error"} />
              {bridgeStateLabel(codex)}
            </span>
          }
        />
        <Row
          label="Account"
          value={
            <span className="inline-flex items-center gap-1.5">
              <StateDot ok={Boolean(codex?.sourceSignedIn)} />
              {codex?.sourceSignedIn ? "signed in" : "signed out"}
            </span>
          }
        />
        {codex?.identity?.email ? <Row label="Email" value={codex.identity.email} /> : null}
        {codex?.identity?.planType ? <Row label="Plan" value={codex.identity.planType} /> : null}
        {codex?.usage?.ordinaryUsageAllowed !== undefined ? (
          <Row
            label="Included usage"
            value={codex.usage.ordinaryUsageAllowed ? "allowed" : "exhausted"}
          />
        ) : (
          <Row label="Usage" value={<span className="text-foreground-subtle">not reported</span>} />
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {actionButton(
            codex?.sourceSignedIn ? "Reconnect" : "Connect",
            () => void connect("codex"),
            { disabled: busy !== null || !codex?.installed },
          )}
          {actionButton("Restart bridge", () => void reconnectBridge("codex"), {
            subtle: true,
            disabled: busy !== null || !codex?.installed,
          })}
          {actionButton("Disconnect from harness", () => void disconnect("codex"), {
            subtle: true,
            disabled: busy !== null || codex?.state !== "connected",
          })}
        </div>
        <p className="mt-2 text-ui-xs text-foreground-subtle">
          Disconnecting stops the harness bridge only. Your Codex sign-in is left untouched.
        </p>

        <div className="mt-4 border-t border-card-border pt-3">
          <div className="flex items-center justify-between">
            <span className="text-ui-xs font-medium">Import Codex history</span>
            {actionButton("Scan", () => void scanCodexHistory(10), {
              subtle: true,
              disabled: busy !== null,
            })}
          </div>
          <p className="mt-1 text-ui-xs text-foreground-subtle">
            Reads Codex&apos;s local transcripts. Works whether or not the account is connected.
          </p>
          {codexCandidates.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {codexCandidates.map((candidate) => (
                <li
                  key={candidate.sessionId}
                  className="flex items-center justify-between gap-3 rounded-md bg-surface px-2 py-1"
                >
                  <span className="truncate text-ui-xs">
                    {candidate.workspacePath.split("/").pop() || candidate.workspacePath}
                  </span>
                  <span className="shrink-0 text-ui-xs text-foreground-subtle tabular-nums">
                    {new Date(candidate.updatedAt).toLocaleDateString()}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Card>

      {/* ---------------------------------------------------------- Claude Code */}
      <Card title="Claude Code" subtitle="Anthropic account via the Claude Code CLI">
        <Row label="Installed" value={claude?.installed ? (claude.version ?? "yes") : "no"} />
        <Row
          label="Account"
          value={
            <span className="inline-flex items-center gap-1.5">
              <StateDot ok={Boolean(claude?.sourceSignedIn)} />
              {claude?.sourceSignedIn ? "signed in" : "signed out"}
            </span>
          }
        />
        {claude?.identity?.authMethod ? (
          <Row label="Auth method" value={claude.identity.authMethod} />
        ) : null}
        {claude?.identity?.apiProvider ? (
          <Row label="Provider" value={claude.identity.apiProvider} />
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {actionButton("Connect Claude Code", () => void connect("claude-code"), {
            disabled: busy !== null || !claude?.installed,
          })}
          {actionButton("Disconnect from harness", () => void disconnect("claude-code"), {
            subtle: true,
            disabled: busy !== null,
          })}
        </div>
      </Card>

      {/* -------------------------------------------------------- Command Code */}
      <Card title="Command Code" subtitle="Account status from the supported CLI surface">
        <CommandCodeCard status={commandCode} />
      </Card>

      {/* ------------------------------------ Claude history import (reused) */}
      <Card
        title="Import Claude history"
        subtitle="Reuses the existing Claude migration; available any time, not just during onboarding"
      >
        <MigrationSection
          workspacePath={workspacePath}
          {...(workspaceIdentity ? { workspaceIdentity } : {})}
          {...(isDesktop === undefined ? {} : { isDesktop })}
        />
      </Card>
    </div>
  );
}

function CommandCodeCard({ status }: { status: CommandCodeStatus | null }) {
  if (!status) return <p className="text-ui-xs text-foreground-subtle">Loading…</p>;
  if (!status.installed) return <p className="text-ui-xs text-foreground-subtle">Not installed</p>;
  return (
    <>
      <Row label="Version" value={status.version ?? "unknown"} />
      <Row
        label="Account"
        value={
          <span className="inline-flex items-center gap-1.5">
            <StateDot ok={status.authenticated} />
            {status.authenticated ? "authenticated" : "signed out"}
          </span>
        }
      />
      {status.user ? <Row label="User" value={status.user} /> : null}
      {status.defaultModel ? <Row label="Default model" value={status.defaultModel} /> : null}
      {status.contextWindow ? (
        <Row label="Context window" value={status.contextWindow.toLocaleString()} />
      ) : null}
      <p className="mt-2 text-ui-xs text-foreground-subtle">
        Plan and usage metrics are not shown because the CLI exposes them only through its
        interactive overlay. No figures are inferred.
      </p>
    </>
  );
}
