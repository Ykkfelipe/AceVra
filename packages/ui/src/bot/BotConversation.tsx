/**
 * Bot 的持久对话面。
 *
 * 复用既有单 pane 会话栈（V4ChatPane = V4ConversationProvider + SessionPane）：
 * composer、流式、工具渲染、权限、rewind 全部沿用既有实现，这里不复制任何一套。
 *
 * 本组件唯一额外拥有的是「哪个 session 是 Bot 的对话」这个 UI 侧状态，并且它只是
 * BotConversationShell 指针的镜像——指针的持久事实仍归 bot 模块（M1 §2）。
 *
 * 指针生命周期（spec §13.4）：
 * - 读指针：null → draft，首发由 SessionPane 建会话；
 * - 绑定已有指针：由订阅解析它，sessionNotFound 时清指针回落到 draft；
 * - onSessionCreated / onSessionDeleted：只在 CLI 接受后写指针。
 *
 * 刻意不做“预检”：existing-only 读取检查的是**运行时是否存活**，不是会话是否存在。
 * 冷启动时 Bot 运行时本来就是 lazy 的，预检会把有效指针误判为失效并清掉。
 * 打开 Bot 必然要订阅会话，因此校验由正常打开路径完成，不额外拉起运行时。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { BotConversationShell } from "@zcode/services";
import { Spinner } from "@/components/ui/spinner.js";
import { useBotService } from "@/hooks/useBotHome.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { V4ChatPane } from "@/v4/V4ChatPane.js";
import { logger } from "@/logger.js";

interface BotConversationProps {
  isDesktop?: boolean;
}

export function BotConversation({ isDesktop = false }: BotConversationProps) {
  const { intl } = useZCodeIntl();
  const botService = useBotService();
  const [shell, setShell] = useState<BotConversationShell | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  // 指针写入是异步的；卸载后不再写状态。
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!botService) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    void botService
      .getConversationShell()
      .then((next) => {
        if (cancelled) return;
        setShell(next);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        logger.warn("[bot] 无法读取 Bot 对话外壳", {
          error: error instanceof Error ? error.message : String(error),
        });
        setLoadFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [botService]);

  /** CLI 已接受 create/delete 之后才落盘指针；写失败只降级告警，不回滚已建立的 UI 绑定。 */
  const persistSession = useCallback(
    async (sessionId: string | null) => {
      if (!botService) return;
      try {
        const updated = await botService.setConversationSession(sessionId);
        if (mountedRef.current) setShell(updated);
      } catch (error) {
        logger.warn("[bot] 无法持久化 Bot 对话指针", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [botService],
  );

  const handleSessionCreated = useCallback(
    (sessionId: string) => {
      // 先本地生效：会话已经存在，UI 不该等一次文件 IO 才切到它。
      setShell((previous) => (previous ? { ...previous, sessionId } : previous));
      void persistSession(sessionId);
    },
    [persistSession],
  );

  const handleSessionDeleted = useCallback(() => {
    setShell((previous) => (previous ? { ...previous, sessionId: null } : previous));
    void persistSession(null);
  }, [persistSession]);

  // 指针指向的 session 已不存在：清指针回落到 draft。
  // 只动 conversation.json——identity / profile / memory 不受影响（M1 §4）。
  const handleSessionUnavailable = useCallback(() => {
    logger.info("[bot] Bot 对话指针已失效，回落到新会话");
    setShell((previous) => (previous ? { ...previous, sessionId: null } : previous));
    void persistSession(null);
  }, [persistSession]);

  if (!botService) {
    return null;
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 bg-background">
        <Spinner className="size-4" />
        <span className="text-ui-sm text-muted-foreground">
          {intl.formatMessage({ id: "bot.conversation.starting" })}
        </span>
      </div>
    );
  }

  if (loadFailed || !shell) {
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
        workspacePath={shell.workspacePath}
        sessionId={shell.sessionId}
        isDesktop={isDesktop}
        onSessionCreated={handleSessionCreated}
        onSessionDeleted={handleSessionDeleted}
        onSessionUnavailable={handleSessionUnavailable}
      />
    </div>
  );
}
