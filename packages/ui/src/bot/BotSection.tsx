/**
 * Personal Bot 主视图：一个持续的 Bot 身份，而不是一次 coding session。
 *
 * 只读 Bot 服务面（身份/档案、对话外壳、个人记忆、能力面）；不写会话消息，
 * 也不把 Bot 混进 Coding Sessions 列表。
 */
import { Bot as BotIcon, RefreshCw } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useBotHome } from "@/hooks/useBotHome.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  BotCapabilityAvailability,
  BotCapabilityEntry,
  PersonalMemoryRecord,
} from "@zcode/services";

const MAX_VISIBLE_MEMORY = 8;

function initialOf(displayName: string): string {
  return displayName.trim().slice(0, 1).toUpperCase() || "A";
}

function availabilityMessageId(availability: BotCapabilityAvailability): string {
  if (availability === "available") return "bot.capability.available";
  if (availability === "planned") return "bot.capability.planned";
  return "bot.capability.notConfigured";
}

function MemoryRow({ record }: { record: PersonalMemoryRecord }) {
  const { intl } = useZCodeIntl();
  return (
    <li className="flex flex-col gap-1 border-b border-border/60 py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        <Badge variant="outline">
          {intl.formatMessage({ id: `bot.memory.category.${record.category}` })}
        </Badge>
        <span className="min-w-0 truncate text-ui-sm text-foreground">{record.title}</span>
      </div>
      {record.summary ? (
        <p className="line-clamp-2 text-ui-xs text-muted-foreground">{record.summary}</p>
      ) : null}
    </li>
  );
}

function CapabilityRow({ entry }: { entry: BotCapabilityEntry }) {
  const { intl } = useZCodeIntl();
  return (
    <li className="flex items-center justify-between gap-3 border-b border-border/60 py-2 last:border-b-0">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-ui-sm text-foreground">
          {intl.formatMessage({ id: `bot.capability.domain.${entry.domain}` })}
        </span>
        <span className="truncate text-ui-xs text-muted-foreground">{entry.summary}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {entry.requiresApproval ? (
          <Badge variant="ghost">{intl.formatMessage({ id: "bot.capability.approval" })}</Badge>
        ) : null}
        <Badge variant={entry.availability === "available" ? "secondary" : "outline"}>
          {intl.formatMessage({ id: availabilityMessageId(entry.availability) })}
        </Badge>
      </div>
    </li>
  );
}

export function BotSection() {
  const { intl } = useZCodeIntl();
  const { identity, memory, capabilities, shell, loading, error, available, refresh } =
    useBotHome();

  if (!available) {
    return (
      <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-background px-6">
        <p className="text-ui-sm text-muted-foreground">
          {intl.formatMessage({ id: "bot.unavailable" })}
        </p>
      </div>
    );
  }

  const displayName = identity?.profile.displayName ?? "";
  const visibleMemory = memory.slice(0, MAX_VISIBLE_MEMORY);

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto bg-background [scrollbar-gutter:stable]"
      data-testid="bot-section"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6 md:px-6">
        <header className="flex items-center gap-3">
          <Avatar size="lg">
            <AvatarFallback>{initialOf(displayName)}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="truncate text-ui-xl font-medium text-foreground">
              {displayName || intl.formatMessage({ id: "bot.fallbackName" })}
            </h1>
            <p className="truncate text-ui-sm text-muted-foreground">
              {identity?.profile.descriptor ?? ""}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void refresh()}
            aria-label={intl.formatMessage({ id: "bot.refresh" })}
          >
            <RefreshCw className="size-4" />
          </Button>
        </header>

        {loading ? (
          <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
            <Spinner className="size-4" />
            {intl.formatMessage({ id: "bot.loading" })}
          </div>
        ) : null}

        {error ? (
          <p className="text-ui-sm text-destructive">
            {intl.formatMessage({ id: "bot.loadFailed" })}
          </p>
        ) : null}

        {identity ? (
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant="outline">
              {intl.formatMessage({ id: `bot.style.tone.${identity.profile.style.tone}` })}
            </Badge>
            <Badge variant="outline">
              {intl.formatMessage({
                id: `bot.style.verbosity.${identity.profile.style.verbosity}`,
              })}
            </Badge>
            <Badge variant="outline">
              {intl.formatMessage({ id: `bot.style.accent.${identity.profile.style.accent}` })}
            </Badge>
          </div>
        ) : null}

        <section className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <BotIcon className="size-4 text-muted-foreground" />
            <h2 className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "bot.section.conversation" })}
            </h2>
          </div>
          <dl className="flex flex-col gap-1 text-ui-xs">
            <div className="flex gap-2">
              <dt className="shrink-0 text-muted-foreground">
                {intl.formatMessage({ id: "bot.conversation.workspace" })}
              </dt>
              <dd className="min-w-0 truncate text-foreground">{shell?.workspacePath ?? ""}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="shrink-0 text-muted-foreground">
                {intl.formatMessage({ id: "bot.conversation.status" })}
              </dt>
              <dd className="min-w-0 truncate text-foreground">
                {shell?.sessionId
                  ? intl.formatMessage({ id: "bot.conversation.linked" })
                  : intl.formatMessage({ id: "bot.conversation.notStarted" })}
              </dd>
            </div>
          </dl>
        </section>

        <section className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
          <h2 className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "bot.section.capabilities" })}
          </h2>
          <ul className="flex flex-col">
            {(capabilities?.entries ?? []).map((entry) => (
              <CapabilityRow key={entry.domain} entry={entry} />
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "bot.section.memory" })}
            </h2>
            <span className="text-ui-xs text-muted-foreground">
              {intl.formatMessage({ id: "bot.memory.count" }, { count: String(memory.length) })}
            </span>
          </div>
          {visibleMemory.length === 0 ? (
            <p className="text-ui-xs text-muted-foreground">
              {intl.formatMessage({ id: "bot.memory.empty" })}
            </p>
          ) : (
            <ul className="flex flex-col">
              {visibleMemory.map((record) => (
                <MemoryRow key={record.id} record={record} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
