/**
 * Broken-pipe guard for process stdio, shared by Desktop Main and the Local Host
 * (packages/desktop/specs/desktop-host-unification.md "Renderer crash recovery and host stdio").
 *
 * dev 脚本或父终端退出后，stdout/stderr 管道可能已关闭；console.* 会同步抛出或异步发出
 * EPIPE。控制台只是便利副本（Main 有文件日志，Host 经 host-log 中继给 Main），日志输出绝不能
 * 反过来杀掉进程。修复依据（2026-10-02 18:28 实测）：Host 没有这层保护，EPIPE 成为
 * uncaughtException，每次重启 3 ms 内再次崩溃，直到 Main 放弃并退出应用。
 */
export function isBrokenPipeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EPIPE"
  );
}

/** Stream `error` listener: swallow EPIPE, rethrow everything else so real faults stay loud. */
export function ignoreBrokenPipeStreamError(error: Error): void {
  if (!isBrokenPipeError(error)) {
    throw error;
  }
}

interface ErrorEmittingStream {
  on(event: "error", listener: (error: Error) => void): unknown;
}

export function installBrokenPipeGuards(streams: readonly ErrorEmittingStream[]): void {
  for (const stream of streams) stream.on("error", ignoreBrokenPipeStreamError);
}

/** Call a console function; a synchronous EPIPE is dropped, any other error propagates. */
export function callIgnoringBrokenPipe(write: () => void): void {
  try {
    write();
  } catch (error) {
    if (!isBrokenPipeError(error)) {
      throw error;
    }
  }
}
