// Pure coercion/target helpers shared by the lease authority and its projection paths.
// 从 authority.ts 抽出：契约方法数与文件行数是架构红线，纯函数不依赖运行时状态。
import type { ComputerUseTargetReport } from "./contract.js";

export const MAX_TEXT = 160;

export function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, MAX_TEXT) : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function workspaceTargetOf(
  target: ComputerUseTargetReport | undefined,
): { pid: number; windowId: number | null; appName: string | null } | undefined {
  const pid = finiteNumber(target?.pid);
  if (pid === undefined) return undefined;
  return {
    pid,
    windowId: finiteNumber(target?.windowId) ?? null,
    appName: boundedText(target?.app) ?? null,
  };
}

export function sanitizeTarget(
  value: ComputerUseTargetReport | undefined,
): ComputerUseTargetReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const target: ComputerUseTargetReport = {
    ...(finiteNumber(value.pid) !== undefined ? { pid: value.pid } : {}),
    ...(finiteNumber(value.windowId) !== undefined ? { windowId: value.windowId } : {}),
    ...(boundedText(value.app) ? { app: boundedText(value.app) } : {}),
    ...(boundedText(value.bundleId) ? { bundleId: boundedText(value.bundleId) } : {}),
    ...(boundedText(value.window) ? { window: boundedText(value.window) } : {}),
  };
  return Object.keys(target).length > 0 ? target : undefined;
}
