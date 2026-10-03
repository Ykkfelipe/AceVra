/**
 * Bot 的对话面。
 *
 * 复用既有单 pane 会话栈（V4ChatPane = V4ConversationProvider + SessionPane）：
 * composer、流式、工具渲染、权限、rewind 全部沿用既有实现，这里不复制任何一套。
 *
 * 「哪个 session 是当前 Bot 对话」由 BotWorkspaceProvider 镜像 BotConversationShell 指针，
 * 指针的持久事实仍归 bot 模块（M1 §2）；本组件只把 pane 回调连同它当时绑定的 sessionId
 * 转交给控制器，由控制器判定回调是否过期（spec §16.4）。
 *
 * 刻意不做“预检”：existing-only 读取检查的是**运行时是否存活**，不是会话是否存在。
 * 冷启动时 Bot 运行时本来就是 lazy 的，预检会把有效指针误判为失效并清掉。
 * 打开 Bot 必然要订阅会话，因此校验由正常打开路径完成（sessionNotFound → 自愈）。
 */
import { useCallback } from "react";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { V4ChatPane } from "@/v4/V4ChatPane.js";
import type { SessionPanePresentation } from "@/v4/SessionPane.js";
import { useBotWorkspace } from "@/bot/BotWorkspaceProvider.js";

interface BotConversationProps {
  isDesktop?: boolean;
}

export function BotConversation({ isDesktop = false }: BotConversationProps) {
  const { intl } = useZCodeIntl();
  const {
    available,
    shellStatus,
    workspacePath,
    selectedSessionId,
    reportSessionCreated,
    reportSessionDeleted,
    reportSessionUnavailable,
    reportSessionPresentation,
  } = useBotWorkspace();

  const handleSessionCreated = useCallback(
    (sessionId: string) => reportSessionCreated(sessionId),
    [reportSessionCreated],
  );
  const handleSessionDeleted = useCallback(
    () => reportSessionDeleted(selectedSessionId),
    [reportSessionDeleted, selectedSessionId],
  );
  const handleSessionUnavailable = useCallback(() => {
    if (selectedSessionId) reportSessionUnavailable(selectedSessionId);
  }, [reportSessionUnavailable, selectedSessionId]);
  const handleSessionPresentationChange = useCallback(
    (presentation: SessionPanePresentation) => reportSessionPresentation(presentation),
    [reportSessionPresentation],
  );

  if (!available) {
    return null;
  }

  if (shellStatus === "loading" || (shellStatus === "ready" && !workspacePath)) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 bg-background">
        <Spinner className="size-4" />
        <span className="text-ui-sm text-muted-foreground">
          {intl.formatMessage({ id: "bot.conversation.starting" })}
        </span>
      </div>
    );
  }

  if (shellStatus === "error" || !workspacePath) {
    return (
      <div className="flex flex-1 items-center justify-center bg-background px-6">
        <p className="text-ui-sm text-destructive">
          {intl.formatMessage({ id: "bot.conversation.loadFailed" })}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <V4ChatPane
        workspacePath={workspacePath}
        sessionId={selectedSessionId}
        isDesktop={isDesktop}
        onSessionCreated={handleSessionCreated}
        onSessionDeleted={handleSessionDeleted}
        onSessionUnavailable={handleSessionUnavailable}
        onSessionPresentationChange={handleSessionPresentationChange}
        composerPlaceholderVariant="assistant"
        // Bot 对话必须在创建期就打上 personal_bot：这样它不进 Coding Sessions，
        // 也是个人记忆注入的唯一门禁（非 personal_bot 连 host 往返都不会发生）。
        createSessionTaskType="personal_bot"
      />
    </div>
  );
}
