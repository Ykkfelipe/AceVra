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
import { homedir } from "node:os";
import { join } from "node:path";
import type { ZCodeImportableSessionCandidate } from "@zcode/shared";
import { parseCodexRolloutPreview } from "#src/accounts/codexHistoryImportParser.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const logger = createServiceLogger("codex-history-import");

export function resolveCodexSessionsDir(codexHome?: string): string {
  const configuredHome = codexHome?.trim() || process.env.CODEX_HOME?.trim();
  if (!configuredHome && process.env.NODE_TEST_CONTEXT) {
    throw new Error(
      "Codex history tests require an isolated CODEX_HOME or an explicit codexHome option",
    );
  }
  if (configuredHome && process.env.NODE_TEST_CONTEXT) {
    const homeDirectory = homedir();
    const normalizedHome = configuredHome.replace(/[\\/]+$/, "");
    const normalizedRealCodexHome = join(homeDirectory, ".codex");
    if (normalizedHome === normalizedRealCodexHome) {
      throw new Error("Codex history tests cannot use the real Codex home directory");
    }
  }
  return join(configuredHome || join(homedir(), ".codex"), "sessions");
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

    const preview = await parseCodexRolloutPreview(file).catch(() => null);
    if (!preview) continue;
    if (options.workspacePath && preview.workspacePath !== options.workspacePath) continue;

    candidates.push({
      provider: "codex",
      sessionId: preview.sessionId,
      workspacePath: preview.workspacePath,
      sourcePath: file,
      updatedAt,
      createdAt: preview.createdAt,
      previewTitle: preview.title,
      previewMessages: preview.previewMessages,
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
