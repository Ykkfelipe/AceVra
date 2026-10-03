/**
 * Personal Bot 主视图：一个持续的 Ace 对话，而不是一次 coding session。
 *
 * 对话占据主区域（BotConversation 复用既有单 pane 会话栈）；身份、能力面与记忆收在侧栏，
 * 它们是 Bot 的上下文，不是主界面。
 *
 * 数据只经 Bot 服务面读取；不读 Bot 数据文件，也不把 Bot 混进 Coding Sessions 列表。
 */
import { RefreshCw } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useBotHome } from "@/hooks/useBotHome.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BotConversation } from "@/bot/BotConversation.js";
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

interface BotSectionProps {
  isDesktop?: boolean;
}

export function BotSection({ isDesktop = false }: BotSectionProps) {
  const { intl } = useZCodeIntl();
  const { identity, memory, capabilities, loading, error, available, refresh } = useBotHome();

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
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background" data-testid="bot-section">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3 md:px-5">
        <Avatar size="lg">
          <AvatarFallback>{initialOf(displayName)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="truncate text-ui-base font-medium text-foreground">
            {displayName || intl.formatMessage({ id: "bot.fallbackName" })}
          </h1>
          <p className="truncate text-ui-xs text-muted-foreground">
            {identity?.profile.descriptor ?? ""}
          </p>
        </div>
        {identity ? (
          <div className="hidden shrink-0 items-center gap-1 lg:flex">
            <Badge variant="outline">
              {intl.formatMessage({ id: `bot.style.tone.${identity.profile.style.tone}` })}
            </Badge>
            <Badge variant="outline">
              {intl.formatMessage({
                id: `bot.style.verbosity.${identity.profile.style.verbosity}`,
              })}
            </Badge>
          </div>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void refresh()}
          aria-label={intl.formatMessage({ id: "bot.refresh" })}
        >
          <RefreshCw className="size-4" />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* 对话是主区域：始终渲染，不因侧栏数据加载状态而延迟。 */}
        <div className="flex min-h-0 flex-1 flex-col">
          <BotConversation isDesktop={isDesktop} />
        </div>

        <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-t border-border p-4 [scrollbar-gutter:stable] md:w-80 md:border-t-0 md:border-l">
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

          <section className="flex flex-col gap-1">
            <h2 className="text-ui-sm font-medium text-foreground">
              {intl.formatMessage({ id: "bot.section.memory" })}
            </h2>
            <span className="text-ui-xs text-muted-foreground">
              {intl.formatMessage({ id: "bot.memory.count" }, { count: String(memory.length) })}
            </span>
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

          <section className="flex flex-col gap-1">
            <h2 className="text-ui-sm font-medium text-foreground">
              {intl.formatMessage({ id: "bot.section.capabilities" })}
            </h2>
            <ul className="flex flex-col">
              {(capabilities?.entries ?? []).map((entry) => (
                <CapabilityRow key={entry.domain} entry={entry} />
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
