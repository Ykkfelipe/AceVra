import type { ComputerTestResult } from "@zcode/shared";
import { fetchWorkerToken, type SpawnFn } from "./sshCommand.js";
import { createSshTunnel } from "./sshTunnel.js";

/** Settings "Test connection": SSH + worker health + token readable, without saving anything. */
export async function testComputer(
  deps: { spawn: SpawnFn; fetch: typeof fetch },
  input: { hostAlias: string; workerPort: number },
): Promise<ComputerTestResult> {
  const tunnel = createSshTunnel({ ...input, spawn: deps.spawn, fetch: deps.fetch });
  try {
    const state = await tunnel.ensure();
    if (state.kind !== "online")
      return { ok: false, reason: state.kind === "offline" ? state.reason : "not_connected" };
    const health = await deps
      .fetch(`http://127.0.0.1:${state.port}/health`, { signal: AbortSignal.timeout(5_000) })
      .then((r) => r.json() as Promise<Record<string, unknown>>)
      .catch(() => null);
    const token = await fetchWorkerToken(deps.spawn, input.hostAlias);
    if (!token) return { ok: false, reason: "token_unavailable" };
    return {
      ok: true,
      screen: { width: Number(health?.width ?? 0), height: Number(health?.height ?? 0) },
      version: typeof health?.version === "string" ? health.version : null,
    };
  } finally {
    tunnel.release();
  }
}
