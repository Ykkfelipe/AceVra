import { createHash } from "node:crypto";
import type { ZCodeImportSessionsResult, ZCodeTaskMeta } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { scanCodexImportableSessions } from "#src/accounts/codexHistoryImportRepo.js";
import { parseCodexRollout } from "#src/accounts/codexHistoryImportParser.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

const logger = createServiceLogger("codex-native-import");

export function buildImportedCodexTaskId(workspacePath: string, sessionId: string): string {
  const digest = createHash("sha256")
    .update(`codex:${workspacePath}:${sessionId}`)
    .digest("hex")
    .slice(0, 24);
  return `codex-import-${digest}`;
}

export async function importCodexNativeSessions(params: {
  taskIndexRepo: TaskIndexRepo;
  workspacePath?: string;
  workspaceIdentity?: string;
  sessionIds: string[];
  createImportedSession: (
    source: NonNullable<Awaited<ReturnType<typeof parseCodexRollout>>>,
  ) => Promise<ZCodeTaskMeta>;
  onTaskImported: (meta: ZCodeTaskMeta) => void;
}): Promise<ZCodeImportSessionsResult> {
  const result: ZCodeImportSessionsResult = { imported: [], skipped: [], failed: [] };
  const sessionIds = [...new Set(params.sessionIds.map((id) => id.trim()).filter(Boolean))];
  const candidates = await scanCodexImportableSessions({ workspacePath: params.workspacePath });

  for (const sessionId of sessionIds) {
    const candidate = candidates.find((item) => item.sessionId === sessionId);
    if (!candidate) {
      result.skipped.push({
        provider: "codex",
        sessionId,
        reason: "session_not_found_or_workspace_mismatch",
      });
      continue;
    }
    const taskId = buildImportedCodexTaskId(candidate.workspacePath, sessionId);
    try {
      const existing = await params.taskIndexRepo.getTaskMeta({ taskId });
      if (existing) {
        // 原因：早期 Codex 导入只保存了 migrationSource，未落原始 session ID；显式重试时
        // 通过稳定 taskId 确认来源后补齐元数据，task index 仍是唯一写入者且不会创建副本。
        if (!existing.migrationSourceSessionId) {
          await params.taskIndexRepo.syncTaskMeta({
            meta: {
              ...existing,
              migrationSource: "codex",
              migrationSourceSessionId: sessionId,
            },
          });
        }
        result.skipped.push({
          provider: "codex",
          sessionId,
          reason: "already_imported",
          workspacePath: candidate.workspacePath,
        });
        continue;
      }
      const source = await parseCodexRollout(candidate.sourcePath);
      if (!source) {
        result.skipped.push({
          provider: "codex",
          sessionId,
          reason: "transcript_unsupported_or_empty",
          workspacePath: candidate.workspacePath,
        });
        continue;
      }
      const meta = await params.createImportedSession(source);
      params.onTaskImported(meta);
      result.imported.push({
        provider: "codex",
        sessionId,
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
      });
    } catch (error) {
      logger.warn(undefined, `Codex history import failed session=${sessionId}`, error);
      result.failed.push({
        provider: "codex",
        sessionId,
        reason: error instanceof Error ? error.message : String(error),
        workspacePath: candidate.workspacePath,
      });
    }
  }
  return result;
}
