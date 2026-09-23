/**
 * Codex local conversation history — candidate discovery.
 *
 * Reads Codex's own rollout transcripts from `~/.codex/sessions/<yyyy>/<mm>/<dd>/*.jsonl`.
 * Verified shape (codex-cli 0.155.x): the first line of each rollout is a header record
 * whose `payload` carries `session_id`, `cwd`, `timestamp` and `cli_version`.
 *
 * SECURITY: this reads conversation transcripts only. It never opens `~/.codex/auth.json`
 * and never touches credential material. History import is deliberately INDEPENDENT of the
 * account bridge — it works whether or not the Codex account is connected.
 *
 * This module only discovers and parses; it does not mutate Codex's store.
 */
import { readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ZCodeImportableSessionCandidate } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const logger = createServiceLogger("codex-history-import");

export function resolveCodexSessionsDir(codexHome?: string): string {
  return join(
    codexHome?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
    "sessions",
  );
}

/** Read only the first line of a rollout; the header is all we need for a candidate. */
async function readRolloutHeader(filePath: string): Promise<Record<string, unknown> | null> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        return JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  } finally {
    rl.close();
    stream.close();
  }
}

async function collectRolloutFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
    }
  }
  await walk(dir, 0);
  return out;
}

export interface CodexHistoryScanOptions {
  readonly codexHome?: string;
  /** Only return sessions whose recorded cwd equals this path. */
  readonly workspacePath?: string;
  /** Only return sessions modified at or after this epoch-ms. */
  readonly modifiedSince?: number;
  readonly limit?: number;
}

export async function scanCodexImportableSessions(
  options: CodexHistoryScanOptions = {},
): Promise<readonly ZCodeImportableSessionCandidate[]> {
  const dir = resolveCodexSessionsDir(options.codexHome);
  const files = await collectRolloutFiles(dir);
  const candidates: ZCodeImportableSessionCandidate[] = [];

  for (const file of files) {
    let updatedAt: number;
    try {
      updatedAt = (await stat(file)).mtimeMs;
    } catch {
      continue;
    }
    if (options.modifiedSince !== undefined && updatedAt < options.modifiedSince) continue;

    const header = await readRolloutHeader(file);
    if (header?.type !== "session_meta") continue;
    const payload = (header.payload ?? null) as Record<string, unknown> | null;
    if (!payload) continue;
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
    const cwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
    if (!sessionId || !cwd) continue;
    if (options.workspacePath && cwd !== options.workspacePath) continue;

    const createdRaw = typeof payload.timestamp === "string" ? Date.parse(payload.timestamp) : NaN;
    candidates.push({
      provider: "codex",
      sessionId,
      workspacePath: cwd,
      sourcePath: file,
      updatedAt,
      ...(Number.isFinite(createdRaw) ? { createdAt: createdRaw } : {}),
    });
  }

  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  // Codex may write multiple rollout files for a fork while retaining the same source id.
  // Keep the newest transcript so the picker and stable task identity expose one candidate.
  const newestBySessionId = new Map<string, ZCodeImportableSessionCandidate>();
  for (const candidate of candidates) {
    const existing = newestBySessionId.get(candidate.sessionId);
    if (!existing || candidate.updatedAt > existing.updatedAt) {
      newestBySessionId.set(candidate.sessionId, candidate);
    }
  }
  const uniqueCandidates = [...newestBySessionId.values()].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
  const limited = options.limit ? uniqueCandidates.slice(0, options.limit) : uniqueCandidates;
  logger.info(
    undefined,
    `codex history scan dir=${dir} files=${files.length} candidates=${limited.length}`,
  );
  return limited;
}
