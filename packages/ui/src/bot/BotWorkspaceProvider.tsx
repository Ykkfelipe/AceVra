/**
 * Bot 工作区的渲染侧控制器（docs/specs/personal-bot.md §16.2 / §16.4）。
 *
 * 只镜像两个权威，不另立事实：
 * - 选中哪个对话：IBotService 的 BotConversationShell.sessionId（conversation.json，唯一持久权威）；
 * - 有哪些对话：CLI session store，经 session/list 的 personal-bot 投影派生。
 *
 * 侧栏（BotConversationSidebar）和主区（BotSection/BotConversation）共用本 context，
 * 选择/新建/删除都从这里写指针，避免两处各自写 conversation.json。
 *
 * 时序约束：
 * - 指针只在已接受的边界写入：用户点选、CLI 已确认的 create/delete、sessionNotFound 自愈；
 * - 过期回调只刷新历史、不改选择：create ACK 只在草稿仍被选中时生效（否则慢一步的 ACK
 *   会把用户从刚点开的对话拉走）；delete / sessionNotFound 只清除仍被选中的那个会话；
 * - 历史读取单飞 + 一次尾随刷新，不用定时器轮询；失败保留上一屏结果，不清指针。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { BotConversationShell } from "@zcode/services";
import { useBotHome, useBotService } from "@/hooks/useBotHome.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import { toBotConversationRows, type BotConversationRow } from "@/bot/botConversationHistory.js";
import {
  createSingleFlight,
  presentationNeedsHistoryRefresh,
  selectionAfterBoundSessionLost,
  selectionAfterSessionCreated,
  type BotPresentationFacts,
} from "@/bot/botWorkspaceSelection.js";

const BOT_HISTORY_LIMIT = 100;

export type BotWorkspaceShellStatus = "loading" | "ready" | "error";
export type BotHistoryStatus = "idle" | "loading" | "ready" | "error";

export type BotSessionPresentation = BotPresentationFacts;

export interface BotWorkspaceValue {
  available: boolean;
  /** 身份/记忆/能力面：侧栏与主区共用一次读取。 */
  home: ReturnType<typeof useBotHome>;
  shellStatus: BotWorkspaceShellStatus;
  workspacePath: string | null;
  selectedSessionId: string | null;
  rows: readonly BotConversationRow[];
  historyStatus: BotHistoryStatus;
  selectConversation: (sessionId: string) => void;
  startNewConversation: () => void;
  refreshHistory: () => void;
  /** pane 从草稿新建了会话（CLI 已确认）。 */
  reportSessionCreated: (sessionId: string) => void;
  reportSessionDeleted: (boundSessionId: string | null) => void;
  reportSessionUnavailable: (boundSessionId: string) => void;
  reportSessionPresentation: (presentation: BotSessionPresentation) => void;
}

const BotWorkspaceContext = createContext<BotWorkspaceValue | null>(null);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface BotWorkspaceProviderProps {
  /** Bot 主视图是否可见；不可见时不发起读取，但保留已加载的选择与历史以便切回。 */
  active: boolean;
  children: ReactNode;
}

export function BotWorkspaceProvider({ active, children }: BotWorkspaceProviderProps) {
  const botService = useBotService();
  const home = useBotHome(active);
  const [shell, setShell] = useState<BotConversationShell | null>(null);
  const [shellStatus, setShellStatus] = useState<BotWorkspaceShellStatus>("loading");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [rows, setRows] = useState<readonly BotConversationRow[]>([]);
  const [historyStatus, setHistoryStatus] = useState<BotHistoryStatus>("idle");
  const workspacePath = shell?.workspacePath ?? null;
  const { zcodeSessionService } = useWorkspaceServices(workspacePath);

  const selectedRef = useRef<string | null>(null);
  const rowsRef = useRef<readonly BotConversationRow[]>([]);
  const selectionInitializedRef = useRef(false);
  const mountedRef = useRef(true);
  const historySingleFlightRef = useRef(createSingleFlight());
  const historyGenerationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applySelection = useCallback((sessionId: string | null) => {
    selectedRef.current = sessionId;
    setSelectedSessionId(sessionId);
  }, []);

  // 打开 Bot 时读指针；首次加载决定初始选择，之后以本窗口的选择为准（写入都经过本控制器）。
  useEffect(() => {
    if (!active || !botService) return;
    let cancelled = false;
    void botService
      .getConversationShell()
      .then((next) => {
        if (cancelled || !mountedRef.current) return;
        setShell(next);
        setShellStatus("ready");
        if (!selectionInitializedRef.current) {
          selectionInitializedRef.current = true;
          applySelection(next.sessionId);
        }
      })
      .catch((error: unknown) => {
        if (cancelled || !mountedRef.current) return;
        logger.warn("[bot] 无法读取 Bot 对话外壳", { error: errorMessage(error) });
        setShellStatus((previous) => (previous === "ready" ? previous : "error"));
      });
    return () => {
      cancelled = true;
    };
  }, [active, applySelection, botService]);

  const runHistoryRefresh = useCallback((): Promise<void> => {
    if (!workspacePath) return Promise.resolve();
    // 单飞合并：进行中再来的请求只补跑一次最新的读取，不叠加并发 RPC。
    return historySingleFlightRef.current.run(async () => {
      historyGenerationRef.current += 1;
      const generation = historyGenerationRef.current;
      setHistoryStatus((previous) => (previous === "ready" ? previous : "loading"));
      try {
        const sessions = await zcodeSessionService.listSessions({
          workspacePath,
          projection: "personal-bot",
          limit: BOT_HISTORY_LIMIT,
        });
        if (generation !== historyGenerationRef.current || !mountedRef.current) return;
        const nextRows = toBotConversationRows(sessions);
        rowsRef.current = nextRows;
        setRows(nextRows);
        setHistoryStatus("ready");
      } catch (error) {
        if (generation !== historyGenerationRef.current || !mountedRef.current) return;
        // 读取失败只影响列表：保留上一屏，不清指针、不挡对话。
        logger.warn("[bot] 无法读取 Bot 对话历史", { error: errorMessage(error) });
        setHistoryStatus("error");
      }
    });
  }, [workspacePath, zcodeSessionService]);

  const refreshHistory = useCallback(() => {
    void runHistoryRefresh();
  }, [runHistoryRefresh]);

  useEffect(() => {
    if (active && workspacePath) void runHistoryRefresh();
  }, [active, runHistoryRefresh, workspacePath]);

  /** 指针写入失败只降级告警：会话已存在，UI 不回滚到旧选择（§13.4 语义）。 */
  const persistPointer = useCallback(
    async (sessionId: string | null) => {
      if (!botService) return;
      try {
        const updated = await botService.setConversationSession(sessionId);
        if (mountedRef.current) setShell(updated);
      } catch (error) {
        logger.warn("[bot] 无法持久化 Bot 对话指针", { error: errorMessage(error) });
      }
    },
    [botService],
  );

  const selectConversation = useCallback(
    (sessionId: string) => {
      if (selectedRef.current === sessionId) return;
      applySelection(sessionId);
      void persistPointer(sessionId);
    },
    [applySelection, persistPointer],
  );

  const startNewConversation = useCallback(() => {
    if (selectedRef.current === null) return;
    // 只换选择，不删除任何会话：旧对话仍在 store 里，历史列表照常列出。
    applySelection(null);
    void persistPointer(null);
  }, [applySelection, persistPointer]);

  const reportSessionCreated = useCallback(
    (sessionId: string) => {
      const next = selectionAfterSessionCreated(selectedRef.current, sessionId);
      if (next !== selectedRef.current) {
        applySelection(next);
        void persistPointer(next);
      }
      void runHistoryRefresh();
    },
    [applySelection, persistPointer, runHistoryRefresh],
  );

  const clearBoundSelection = useCallback(
    (boundSessionId: string | null) => {
      const next = selectionAfterBoundSessionLost(selectedRef.current, boundSessionId);
      if (next === selectedRef.current) return;
      applySelection(next);
      void persistPointer(next);
    },
    [applySelection, persistPointer],
  );

  const reportSessionDeleted = useCallback(
    (boundSessionId: string | null) => {
      clearBoundSelection(boundSessionId);
      void runHistoryRefresh();
    },
    [clearBoundSelection, runHistoryRefresh],
  );

  // 指针指向的 session 已不存在：清指针回落到 draft，只动 conversation.json（M1 §4）。
  const reportSessionUnavailable = useCallback(
    (boundSessionId: string) => {
      logger.info("[bot] Bot 对话指针已失效，回落到新会话", { sessionId: boundSessionId });
      clearBoundSelection(boundSessionId);
      void runHistoryRefresh();
    },
    [clearBoundSelection, runHistoryRefresh],
  );

  const reportSessionPresentation = useCallback(
    (presentation: BotSessionPresentation) => {
      if (presentationNeedsHistoryRefresh(rowsRef.current, presentation)) {
        void runHistoryRefresh();
      }
    },
    [runHistoryRefresh],
  );

  const value = useMemo<BotWorkspaceValue>(
    () => ({
      available: botService !== undefined,
      home,
      shellStatus,
      workspacePath,
      selectedSessionId,
      rows,
      historyStatus,
      selectConversation,
      startNewConversation,
      refreshHistory,
      reportSessionCreated,
      reportSessionDeleted,
      reportSessionUnavailable,
      reportSessionPresentation,
    }),
    [
      botService,
      historyStatus,
      home,
      refreshHistory,
      reportSessionCreated,
      reportSessionDeleted,
      reportSessionPresentation,
      reportSessionUnavailable,
      rows,
      selectConversation,
      selectedSessionId,
      shellStatus,
      startNewConversation,
      workspacePath,
    ],
  );

  return <BotWorkspaceContext.Provider value={value}>{children}</BotWorkspaceContext.Provider>;
}

export function useBotWorkspace(): BotWorkspaceValue {
  const value = useContext(BotWorkspaceContext);
  if (!value) {
    throw new Error("useBotWorkspace 必须在 BotWorkspaceProvider 内使用");
  }
  return value;
}
