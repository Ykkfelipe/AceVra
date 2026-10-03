/**
 * Bot 右侧上下文检查器（docs/specs/personal-bot.md §15 / §16.5）。
 *
 * Memory / Computers / Capabilities 三个标签页，数据与 V1 相同：
 * 记忆与能力面经 IBotService（BotWorkspaceProvider.home），Computers 经账户设备注册表。
 * V2 只调整呈现：安静的分组标题 + 列表行，而不是一摞 coding 卡片。
 */
import { Badge } from "@/components/ui/badge.js";
import { Spinner } from "@/components/ui/spinner.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { BotComputersPanel } from "@/bot/BotComputersPanel.js";
import { useBotWorkspace } from "@/bot/BotWorkspaceProvider.js";
import type {
  BotCapabilityAvailability,
  BotCapabilityEntry,
  PersonalMemoryRecord,
} from "@zcode/services";

const MAX_VISIBLE_MEMORY = 8;
const TAB_CONTENT_CLASS_NAME = "min-h-0 flex-1 overflow-y-auto px-4 py-3 [scrollbar-gutter:stable]";

function availabilityMessageId(availability: BotCapabilityAvailability): string {
  if (availability === "available") return "bot.capability.available";
  if (availability === "planned") return "bot.capability.planned";
  return "bot.capability.notConfigured";
}

function SectionHeading({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 pb-1">
      <h2 className="text-ui-sm font-medium text-foreground">{title}</h2>
      {meta ? <span className="text-ui-xs text-foreground-subtlest">{meta}</span> : null}
    </div>
  );
}

function MemoryRow({ record }: { record: PersonalMemoryRecord }) {
  const { intl } = useZCodeIntl();
  return (
    <li className="flex flex-col gap-1 rounded-lg px-2 py-2 hover:bg-surface-hover">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">{record.title}</span>
        <Badge variant="outline" className="shrink-0">
          {intl.formatMessage({ id: `bot.memory.category.${record.category}` })}
        </Badge>
      </div>
      {record.summary ? (
        <p className="line-clamp-2 text-ui-sm text-foreground-subtle">{record.summary}</p>
      ) : null}
    </li>
  );
}

function CapabilityRow({ entry }: { entry: BotCapabilityEntry }) {
  const { intl } = useZCodeIntl();
  return (
    <li className="flex items-start justify-between gap-3 rounded-lg px-2 py-2">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-ui-base text-foreground">
          {intl.formatMessage({ id: `bot.capability.domain.${entry.domain}` })}
        </span>
        <span className="line-clamp-2 text-ui-sm text-foreground-subtle">{entry.summary}</span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Badge variant={entry.availability === "available" ? "secondary" : "outline"}>
          {intl.formatMessage({ id: availabilityMessageId(entry.availability) })}
        </Badge>
        {entry.requiresApproval ? (
          <span className="text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "bot.capability.approval" })}
          </span>
        ) : null}
      </div>
    </li>
  );
}

export function BotInspector() {
  const { intl } = useZCodeIntl();
  const { home } = useBotWorkspace();
  const { memory, capabilities, loading, error } = home;
  const visibleMemory = memory.slice(0, MAX_VISIBLE_MEMORY);

  return (
    <aside
      data-testid="bot-inspector"
      aria-label={intl.formatMessage({ id: "bot.inspector.label" })}
      className="flex w-full shrink-0 flex-col border-t border-border md:w-80 md:border-t-0 md:border-l"
    >
      <Tabs defaultValue="memory" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="shrink-0 px-3 pt-3 pb-2">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="memory">{intl.formatMessage({ id: "bot.tab.memory" })}</TabsTrigger>
            <TabsTrigger value="computers">
              {intl.formatMessage({ id: "bot.tab.computers" })}
            </TabsTrigger>
            <TabsTrigger value="capabilities">
              {intl.formatMessage({ id: "bot.tab.capabilities" })}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="memory" className={TAB_CONTENT_CLASS_NAME}>
          <SectionHeading
            title={intl.formatMessage({ id: "bot.section.memory" })}
            meta={intl.formatMessage({ id: "bot.memory.count" }, { count: String(memory.length) })}
          />
          {loading && memory.length === 0 ? (
            <div className="flex items-center gap-2 py-2 text-ui-sm text-foreground-subtle">
              <Spinner className="size-3.5" />
              {intl.formatMessage({ id: "bot.loading" })}
            </div>
          ) : null}
          {error ? (
            <p className="py-2 text-ui-sm text-destructive">
              {intl.formatMessage({ id: "bot.loadFailed" })}
            </p>
          ) : null}
          {!loading && !error && visibleMemory.length === 0 ? (
            <p className="py-2 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "bot.memory.empty" })}
            </p>
          ) : null}
          {visibleMemory.length > 0 ? (
            <ul className="-mx-2 flex flex-col gap-0.5">
              {visibleMemory.map((record) => (
                <MemoryRow key={record.id} record={record} />
              ))}
            </ul>
          ) : null}
        </TabsContent>

        <TabsContent value="computers" className={TAB_CONTENT_CLASS_NAME}>
          <BotComputersPanel />
        </TabsContent>

        <TabsContent value="capabilities" className={TAB_CONTENT_CLASS_NAME}>
          <SectionHeading title={intl.formatMessage({ id: "bot.section.capabilities" })} />
          <ul className="-mx-2 flex flex-col gap-0.5">
            {(capabilities?.entries ?? []).map((entry) => (
              <CapabilityRow key={entry.domain} entry={entry} />
            ))}
          </ul>
        </TabsContent>
      </Tabs>
    </aside>
  );
}
