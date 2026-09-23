/** Development-only visual fixtures. This module contains no service or provider imports. */
import type { AccountBridgeStatus } from "@zcode/shared";
import type { UsageQuotaLimit } from "@zcode/shared";
import type { CommandCodeStatus } from "@zcode/services";
import { useState } from "react";
import { AccountBridgeDetailView } from "@/settings/account-bridge/AccountBridgeDetail.js";
import { CommandCodeCliStatusView } from "./CommandCodeCliStatus.js";
import {
  CodingPlanEntryGateNotice,
  CodingPlanStatusCardView,
  PlanUsageMetricCard,
} from "./StatusCards.js";
import { ModelProviderSectionLayout } from "./SectionLayout.js";
import type { ModelProviderNavGroup } from "./constants.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const codex: AccountBridgeStatus = {
  source: "codex",
  installed: true,
  state: "connected",
  sourceSignedIn: true,
  sourceSignInChecked: true,
  checkedAt: "2026-09-23T16:00:00.000Z",
  identity: { planType: "plus" },
  usage: {
    primaryUsedPercent: 32,
    primaryWindowDurationMins: 300,
    primaryResetsAt: "2026-09-23T20:00:00.000Z",
    secondaryUsedPercent: 18,
    secondaryWindowDurationMins: 10080,
    secondaryResetsAt: "2026-09-28T00:00:00.000Z",
  },
};
const claude: AccountBridgeStatus = {
  source: "claude-code",
  installed: true,
  state: "connected",
  sourceSignedIn: true,
  sourceSignInChecked: true,
  checkedAt: "2026-09-23T16:00:00.000Z",
};
const commandCode: CommandCodeStatus = {
  installed: true,
  authenticated: true,
  user: "fixture-user",
  version: "1.62.1",
  defaultModel: "deepseek/deepseek-v4-flash",
  contextWindow: 1_000_000,
  usageUnavailable: true,
  usageUnavailableReason: "fixture: unsupported CLI surface",
  checkedAt: "2026-09-23T16:00:00.000Z",
};
const zaiUsage: UsageQuotaLimit[] = [
  {
    type: "TOKENS_LIMIT",
    percentage: 27,
    nextResetTime: Date.parse("2026-09-23T20:00:00Z"),
    usageDetails: [],
  },
  {
    type: "TOKENS_LIMIT",
    percentage: 14,
    nextResetTime: Date.parse("2026-09-28T00:00:00Z"),
    usageDetails: [],
  },
];

/** Must only be mounted behind `import.meta.env.DEV` and an explicit fixture query parameter. */
export function ModelSettingsFixtureHarness({
  initialScenario = "CODEX_CONNECTED",
}: {
  initialScenario?: string;
} = {}) {
  const [scenario, setScenario] = useState(initialScenario);
  const [, setFixtureAction] = useState(0);
  const bridge = {
    statusFor: (source: AccountBridgeStatus["source"]) => (source === "codex" ? codex : claude),
    busy: null,
    loading: false,
    refreshing: false,
    lastError: null,
    connect: async () => {},
    reconnectBridge: async () => {},
    disconnect: async () => {},
    refreshStatuses: async () => {},
  } as unknown as Parameters<typeof AccountBridgeDetailView>[0]["bridge"];
  const navigationGroups = [
    {
      id: "preset",
      title: "Providers",
      items: [
        {
          type: "preset",
          key: "zai",
          presetId: "zai-start-plan",
          label: "Z.ai",
          displayName: "Z.ai",
          provider: null,
          statusActive: true,
        },
        {
          type: "preset",
          key: "azure",
          presetId: "azure-openai",
          label: "Azure OpenAI",
          displayName: "Azure OpenAI",
          provider: null,
          statusActive: true,
        },
      ],
    },
    {
      id: "custom",
      title: "Other providers",
      items: [
        {
          type: "custom",
          key: "command-code",
          label: "Command Code",
          provider: null,
          statusActive: true,
        },
      ],
    },
    {
      id: "account",
      title: "Connected accounts / execution",
      items: [
        { type: "account", key: "account:codex", label: "Codex", source: "codex" },
        {
          type: "account",
          key: "account:claude-code",
          label: "Claude Code",
          source: "claude-code",
        },
      ],
    },
  ] as unknown as ModelProviderNavGroup[];
  return (
    <main className="min-h-dvh bg-background p-4 text-foreground">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-ui-xl font-semibold">AceVra Dev · Model Settings fixtures</h1>
        <label className="flex items-center gap-2 text-ui-base">
          Scenario
          <select
            className="rounded-lg border border-input-border bg-input p-2"
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
          >
            {[
              "CODEX_CONNECTED",
              "CLAUDE_CONNECTED",
              "COMMAND_CODE_CONFIGURED",
              "ZAI_HEALTHY",
              "ZAI_PARTIAL_PLAN_FAILURE",
              "NAVIGATION",
            ].map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
      </header>
      <p className="mb-4 text-ui-sm text-foreground-subtle">
        Isolated local fixture · provider requests: 0
      </p>
      {scenario === "CODEX_CONNECTED" ? (
        <AccountBridgeDetailView source="codex" bridge={bridge} />
      ) : null}
      {scenario === "CLAUDE_CONNECTED" ? (
        <AccountBridgeDetailView
          source="claude-code"
          bridge={bridge}
          migrationSlot={
            <p className="rounded-xl bg-surface p-4 text-ui-sm text-foreground-subtle">
              History import fixture · workspace services not mounted
            </p>
          }
        />
      ) : null}
      {scenario === "COMMAND_CODE_CONFIGURED" ? (
        <CommandCodeCliStatusView
          status={commandCode}
          loading={false}
          onRefresh={() => {
            setFixtureAction((n) => n + 1);
          }}
        />
      ) : null}
      {scenario === "ZAI_HEALTHY" || scenario === "ZAI_PARTIAL_PLAN_FAILURE" ? (
        <CodingPlanStatusCardView
          title="Z.ai · Coding Plan"
          statusMeta={
            <span className="flex flex-wrap items-center gap-1 text-ui-base text-success">
              Authenticated ·{" "}
              {scenario === "ZAI_HEALTHY" ? (
                "Plan details available"
              ) : (
                <CodingPlanEntryGateNotice onRetry={() => setFixtureAction((n) => n + 1)} />
              )}
            </span>
          }
        >
          <div className="flex w-full gap-2 max-sm:flex-col">
            <PlanUsageMetricCard
              label="5-hour usage"
              limit={zaiUsage[0]}
              progressColor="var(--color-usage-chart-1)"
              resetTimeFormat="dateTime"
            />
            <PlanUsageMetricCard
              label="Weekly usage"
              limit={zaiUsage[1]}
              progressColor="var(--color-usage-chart-2)"
              resetTimeFormat="dateTime"
            />
          </div>
        </CodingPlanStatusCardView>
      ) : null}
      {scenario === "NAVIGATION" ? (
        <TooltipProvider>
          <ModelProviderSectionLayout
            description="Choose a provider or connected account."
            refreshLabel="Refresh"
            loadingLabel="Refreshing"
            presetLoading={false}
            customLoading={false}
            onRefresh={() => setFixtureAction((n) => n + 1)}
            addProviderLabel="Add provider"
            onAddProvider={() => setFixtureAction((n) => n + 1)}
            navigationGroups={navigationGroups}
            selectedNodeKey={null}
            onSelectNavItem={() => {}}
          >
            <p className="text-ui-base text-foreground-subtle">Provider detail fixture</p>
          </ModelProviderSectionLayout>
        </TooltipProvider>
      ) : null}
    </main>
  );
}
