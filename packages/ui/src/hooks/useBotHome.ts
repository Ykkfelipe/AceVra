/**
 * Bot 主页数据：身份/档案、个人记忆、能力面、对话外壳。
 *
 * 组件只通过本 hook 读 Bot 状态；不得直接读 Bot 数据文件或 session 数据库。
 * 旧 host / 测试 double 没有 botService 时返回空状态，UI 据此隐藏 Bot 入口。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BotCapabilitySurface,
  BotIdentityView,
  IBotService,
  PersonalMemoryRecord,
} from "@zcode/services";
import { useServices } from "./useServices.js";

export function useBotService(): IBotService | undefined {
  const { botService } = useServices();
  return botService;
}

interface BotHomeState {
  identity: BotIdentityView | null;
  memory: PersonalMemoryRecord[];
  capabilities: BotCapabilitySurface | null;
  loading: boolean;
  error: unknown | null;
}

const EMPTY_STATE: BotHomeState = {
  identity: null,
  memory: [],
  capabilities: null,
  loading: false,
  error: null,
};

interface BotHomeResult extends BotHomeState {
  available: boolean;
  refresh: () => Promise<void>;
}

export function useBotHome(): BotHomeResult {
  const botService = useBotService();
  const [state, setState] = useState<BotHomeState>(() => ({
    ...EMPTY_STATE,
    loading: botService !== undefined,
  }));
  const generationRef = useRef(0);

  const load = useCallback(async () => {
    if (!botService) {
      setState(EMPTY_STATE);
      return;
    }
    generationRef.current += 1;
    const generation = generationRef.current;
    setState((previous) => ({ ...previous, loading: true, error: null }));

    try {
      const [identity, memory, capabilities] = await Promise.all([
        botService.getIdentity(),
        botService.listMemory(),
        botService.listCapabilitySurface(),
      ]);
      // 服务换代/重复刷新时丢弃过期结果，避免旧响应覆盖新事实。
      if (generation !== generationRef.current) return;
      setState({ identity, memory, capabilities, loading: false, error: null });
    } catch (error) {
      if (generation !== generationRef.current) return;
      setState({ ...EMPTY_STATE, loading: false, error });
    }
  }, [botService]);

  useEffect(() => {
    void load();
    return () => {
      // 卸载后不再写状态。
      generationRef.current += 1;
    };
  }, [load]);

  return { ...state, available: botService !== undefined, refresh: load };
}
