import { useEffect, useRef } from "react";
import { logger } from "@/logger.js";

const STARTUP_GATE_TIMEOUT_MS = 15_000;

type StartupGateName =
  | "startupAuth"
  | "providerStartup"
  | "tabRestore"
  | "initialWorkspaceBootstrap";

type StartupGateDiagnosticDetails = Record<string, boolean | number | string | null | undefined>;

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * RootStartupLoading 只有一屏通用文案，缺少能定位未完成门禁的生产证据。
 * 这里只记录门禁状态转换，不读取业务数据，便于 packaged 启动复现时区分四个 owner。
 */
export function useRootStartupGateDiagnostics(
  gate: StartupGateName,
  pending: boolean,
  details?: StartupGateDiagnosticDetails,
): void {
  const pendingRef = useRef(false);
  const startedAtRef = useRef(0);
  const detailsRef = useRef(details);
  detailsRef.current = details;

  useEffect(() => {
    const now = nowMs();
    if (!pending) {
      if (pendingRef.current) {
        logger.lifecycle.info("startup_gate_ready", {
          gate,
          elapsedMs: Math.round(now - startedAtRef.current),
          ...detailsRef.current,
        });
      }
      pendingRef.current = false;
      return;
    }

    if (!pendingRef.current) {
      startedAtRef.current = now;
      logger.lifecycle.info("startup_gate_begin", {
        gate,
        monotonicMs: Math.round(now),
        ...detailsRef.current,
      });
    }

    pendingRef.current = true;
    const timeoutId = window.setTimeout(() => {
      logger.lifecycle.warn("startup_gate_timeout", {
        gate,
        elapsedMs: Math.round(nowMs() - startedAtRef.current),
        timeoutMs: STARTUP_GATE_TIMEOUT_MS,
        ...detailsRef.current,
      });
    }, STARTUP_GATE_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [gate, pending]);
}
