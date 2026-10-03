/**
 * Bot 检查器「Computers」标签页的实体：复用 coding 侧面板的同一个 ComputerPane
 * （acevra-agent-computer.md §3.3），不建第二条机器注册表。
 *
 * 与 coding 侧面板的两点差异：
 * - visible 恒为 true：Radix Tabs 卸载非激活内容，挂载即当前标签页，隐藏即卸载停流；
 * - Stop 只在 worker job 属于当前选中的 Bot 对话时结束聊天回合，与 coding 的
 *   stopAgentTurn 同一条 stopGeneration 路径，不跨会话猜测。
 */
import { useCallback } from "react";
import { logger } from "@/logger.js";
import { ComputerPane } from "@/computers/ComputerPane.js";
import { useBotWorkspace } from "@/bot/BotWorkspaceProvider.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

interface BotComputerPaneProps {
  computerId: string | null;
  expanded: boolean;
  onToggleExpand: () => void;
  onSelectComputer: (computerId: string) => void;
}

export function BotComputerPane({
  computerId,
  expanded,
  onToggleExpand,
  onSelectComputer,
}: BotComputerPaneProps) {
  const { workspacePath, selectedSessionId } = useBotWorkspace();
  const services = useWorkspaceServices(workspacePath);

  const stopAgentTurn = useCallback(
    (jobSessionId: string) => {
      if (!workspacePath) return;
      if (jobSessionId !== selectedSessionId) {
        logger.warn("[bot-computers] stop: job owner is not the selected conversation", {
          sessionId: jobSessionId,
        });
        return;
      }
      void services.zcodeTaskService
        .stopGeneration({ taskId: jobSessionId, workspacePath })
        .catch((error: unknown) => {
          logger.warn("[bot-computers] stop: ending the agent turn failed", {
            error: String(error),
          });
        });
    },
    [selectedSessionId, services, workspacePath],
  );

  return (
    <ComputerPane
      computerId={computerId}
      visible
      expanded={expanded}
      onToggleExpand={onToggleExpand}
      onSelectComputer={onSelectComputer}
      onStopAgentTurn={stopAgentTurn}
    />
  );
}
