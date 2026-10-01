import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodePaths } from "./dataRoot.js";

/**
 * Append-only diagnostics. Callers pass fixed event names and non-secret facts; values that
 * look like credentials are masked as a defence in depth. Keys, secrets, codes and tokens
 * are never passed in.
 */
const SECRET_LIKE = /[A-Za-z0-9_-]{32,}/g;
export function createLogger(paths: NodePaths) {
  return async (event: string, facts: Record<string, string | number | undefined> = {}) => {
    const detail = Object.entries(facts)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${String(v).replace(SECRET_LIKE, "***")}`)
      .join(" ");
    await appendFile(
      join(paths.logs, "node.log"),
      `${new Date().toISOString()} ${event}${detail ? ` ${detail}` : ""}\n`,
      { mode: 0o600 },
    ).catch(() => undefined);
  };
}
export type NodeLogger = ReturnType<typeof createLogger>;
