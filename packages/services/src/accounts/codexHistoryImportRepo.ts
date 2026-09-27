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
  /** Only return sessions with visible conversation activity at or after this epoch-ms. */
  readonly modifiedSince?: number;
  readonly limit?: number;
}

interface ScannedCodexCandidate {
  candidate: ZCodeImportableSessionCandidate;
  isCanonical: boolean;
  hasAssistant: boolean;
  visibleMessageCount: number;
  mtimeMs: number;
}

function compareRolloutQuality(left: ScannedCodexCandidate, right: ScannedCodexCandidate): number {
  const leftRank = [
    Number(left.isCanonical),
    Number(left.hasAssistant),
    left.visibleMessageCount,
    left.candidate.updatedAt,
    left.candidate.createdAt,
    left.mtimeMs,
  ];
  const rightRank = [
    Number(right.isCanonical),
    Number(right.hasAssistant),
    right.visibleMessageCount,
    right.candidate.updatedAt,
    right.candidate.createdAt,
    right.mtimeMs,
  ];
  for (let index = 0; index < leftRank.length; index += 1) {
    const difference = leftRank[index]! - rightRank[index]!;
    if (difference !== 0) return difference;
  }
  return left.candidate.sourcePath < right.candidate.sourcePath
    ? 1
    : left.candidate.sourcePath > right.candidate.sourcePath
      ? -1
      : 0;
}

export async function scanCodexImportableSessions(
  options: CodexHistoryScanOptions = {},
): Promise<readonly ZCodeImportableSessionCandidate[]> {
  const dir = resolveCodexSessionsDir(options.codexHome);
  const files = await collectRolloutFiles(dir);
  const selectedBySessionId = new Map<string, ScannedCodexCandidate>();

  for (const file of files) {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(file)).mtimeMs;
    } catch {
      continue;
    }

    const preview = await parseCodexRolloutPreview(file).catch(() => null);
    if (!preview || preview.isReviewWrapper) continue;
    if (options.workspacePath && preview.workspacePath !== options.workspacePath) continue;
    if (options.modifiedSince !== undefined && preview.activityAt < options.modifiedSince) continue;

    const candidate: ZCodeImportableSessionCandidate = {
      provider: "codex",
      sessionId: preview.sessionId,
      workspacePath: preview.workspacePath,
      sourcePath: file,
      updatedAt: preview.activityAt,
      createdAt: preview.createdAt,
      previewTitle: preview.title,
      previewMessages: preview.previewMessages,
    };
    const scanned = {
      candidate,
      isCanonical: preview.physicalSessionId === preview.sessionId,
      hasAssistant: preview.hasAssistant,
      visibleMessageCount: preview.visibleMessageCount,
      mtimeMs,
    };
    const existing = selectedBySessionId.get(preview.sessionId);
    // 原因：guardian 复用父 session_id，mtime 更晚时会覆盖真实会话；按来源和可见对话质量选唯一物理文件。
    if (!existing || compareRolloutQuality(scanned, existing) > 0) {
      selectedBySessionId.set(preview.sessionId, scanned);
    }
  }

  const uniqueCandidates = [...selectedBySessionId.values()]
    .map(({ candidate }) => candidate)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
  const limited = options.limit ? uniqueCandidates.slice(0, options.limit) : uniqueCandidates;
  logger.info(
    undefined,
    `codex history scan dir=${dir} files=${files.length} candidates=${limited.length}`,
  );
  return limited;
}
