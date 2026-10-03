/**
 * Cross-Mode → Coding 的启动编排（docs/specs/cross-mode-bot-to-coding.md §5）。
 *
 * 只做传输与导航，不拥有任何交接状态：
 * 1. 按目标项目取连接租约（与「已保存工作流」直接启动同一条连接口径）；
 * 2. 一条 `createSession{ crossModeHandoff: { confirmation } }`——准入、建会话、写 origin、启动首轮
 *    全部在目标 CLI 内完成；
 * 3. ACK 必须带回 `crossModeOrigin`：旧 CLI 会静默丢弃未知键并建出空会话，此时回收该会话并报错；
 * 4. accepted 后交给调用方导航（Bot 指针从不在这里写）。
 */
import { useCallback, useRef, useState } from "react";
import type { HandoffConfirmation } from "@zcode/shared/cross-mode";
import type { CrossModeOriginState } from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { acquireWorkspaceConnection } from "@/v4/workspaceConnectionRegistry.js";

/** 目标项目坐标；本里程碑只提供本机项目（无 remoteSessionId）。 */
export interface CrossModeCodingTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export type CrossModeCodingLaunchResult =
  | { ok: true; sessionId: string; origin: CrossModeOriginState }
  | { ok: false; message: string | null };

export function crossModeCodingWorkspaceId(target: CrossModeCodingTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

export function useCrossModeCodingLaunch(params: {
  onNavigate: (target: CrossModeCodingTarget, sessionId: string) => void;
}) {
  const { onNavigate } = params;
  const { zcodeAgentService } = useServices();
  const [pending, setPending] = useState(false);
  // 同一帧内的重复点击：state 异步，单靠 pending 挡不住。
  const pendingRef = useRef(false);

  const launch = useCallback(
    async (
      target: CrossModeCodingTarget,
      confirmation: HandoffConfirmation,
    ): Promise<CrossModeCodingLaunchResult> => {
      if (pendingRef.current) return { ok: false, message: null };
      pendingRef.current = true;
      setPending(true);
      const lease = acquireWorkspaceConnection(
        {
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
        },
        zcodeAgentService,
      );
      try {
        const ack = await lease.transport.sendCommand(
          createCommandEnvelope({
            type: "createSession",
            payload: {
              workspaceId: crossModeCodingWorkspaceId(target),
              crossModeHandoff: {
                confirmation: { ...confirmation, warnings: [...confirmation.warnings] },
              },
            },
            sessionId: null,
          }),
        );
        if (ack.status !== "accepted" || ack.result?.type !== "createSession") {
          logger.warn("[cross-mode] Coding 交接被拒", {
            handoffId: confirmation.handoffId,
            reasonCode: ack.reasonCode ?? null,
            status: ack.status,
          });
          return { ok: false, message: ack.message ?? null };
        }
        const { sessionId, crossModeOrigin } = ack.result;
        if (!crossModeOrigin || crossModeOrigin.handoffId !== confirmation.handoffId) {
          // 旧 CLI 丢弃了 crossModeHandoff：会话是空的、没有来源，不能当成交接成功。
          logger.warn("[cross-mode] Coding 运行时未执行交接，回收空会话", {
            handoffId: confirmation.handoffId,
            sessionId,
          });
          void lease.transport
            .sendCommand(createCommandEnvelope({ type: "deleteSession", payload: {}, sessionId }))
            .catch(() => undefined);
          return { ok: false, message: null };
        }
        logger.info("[cross-mode] Coding 交接已接受", {
          handoffId: crossModeOrigin.handoffId,
          sessionId,
        });
        onNavigate(target, sessionId);
        return { ok: true, sessionId, origin: crossModeOrigin };
      } catch (error) {
        logger.warn("[cross-mode] Coding 交接请求失败", {
          error: error instanceof Error ? error.message : String(error),
          handoffId: confirmation.handoffId,
        });
        return { ok: false, message: error instanceof Error ? error.message : null };
      } finally {
        lease.release();
        pendingRef.current = false;
        setPending(false);
      }
    },
    [onNavigate, zcodeAgentService],
  );

  return { launch, pending };
}
