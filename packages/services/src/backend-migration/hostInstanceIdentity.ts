// Host 实例身份与存活判定（spec Amendment 3）。tasks-index 被多个窗口 Host 进程共享，
// pendingBackendTransition.ownerInstanceId 记录发起迁移的实例；恢复前用这里判定所有者是否存活。
import { randomUUID } from "node:crypto";

export function createHostInstanceId(pid: number = process.pid): string {
  return `${pid}:${randomUUID()}`;
}

function parseOwnerPid(ownerInstanceId: string): number | null {
  const pid = Number.parseInt(ownerInstanceId.split(":")[0] ?? "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程存在但无权发信号——仍视为存活，绝不抢占。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * - owner 缺失（旧数据）→ 不存活；
 * - owner 就是本实例 → 只有本实例内存里确实有这次在途迁移才算存活；
 * - owner 与本进程同 pid 但不同 boot → 上一次启动的遗留，不存活；
 * - 其它 pid → 以操作系统进程存活为准。
 */
export function createOwnerLivenessCheck(params: {
  readonly selfInstanceId: string;
  readonly hasActiveMigrationOwnedBySelf: (ownerInstanceId: string) => boolean;
  readonly isPidAlive?: (pid: number) => boolean;
  readonly selfPid?: number;
}): (ownerInstanceId: string | undefined) => boolean {
  const isPidAlive = params.isPidAlive ?? isProcessAlive;
  const selfPid = params.selfPid ?? process.pid;
  return (ownerInstanceId) => {
    if (!ownerInstanceId) return false;
    if (ownerInstanceId === params.selfInstanceId) {
      return params.hasActiveMigrationOwnedBySelf(ownerInstanceId);
    }
    const pid = parseOwnerPid(ownerInstanceId);
    if (pid === null || pid === selfPid) return false;
    return isPidAlive(pid);
  };
}
