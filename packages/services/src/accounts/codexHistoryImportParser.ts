import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { ZCodeImportableSessionPreviewMessage } from "@zcode/shared";
import { deriveSessionTitle } from "#src/session/sessionTitle.js";

export const CODEX_IMPORT_PREVIEW_MAX_CODE_POINTS = 240;

export interface CodexImportedMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
}

export interface CodexImportedSession {
  sessionId: string;
  workspacePath: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  model?: string;
  messages: CodexImportedMessage[];
}

export interface CodexRolloutPreview {
  sessionId: string;
  workspacePath: string;
  createdAt: number;
  title: string;
  previewMessages: ZCodeImportableSessionPreviewMessage[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function textContent(value: unknown, expectedType: "input_text" | "output_text"): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      const item = object(part);
      if (!item || item.type !== expectedType || typeof item.text !== "string") return [];
      const text = item.text.trim();
      return text ? [text] : [];
    })
    .join("\n\n");
}

function truncatePreviewText(text: string): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= CODEX_IMPORT_PREVIEW_MAX_CODE_POINTS) return text;
  return `${codePoints.slice(0, CODEX_IMPORT_PREVIEW_MAX_CODE_POINTS - 3).join("")}...`;
}

/** Remove injected context even when Codex batches it with an actual user prompt. */
function sanitizeCodexUserText(text: string): string {
  return text
    .replace(/^#\s*AGENTS\.md\s+instructions\s+for\b[^\n]*\n/imu, "")
    .replace(
      /<(?:INSTRUCTIONS|environment_context|meta_user|context)\b[^>]*>[\s\S]*?<\/(?:INSTRUCTIONS|environment_context|meta_user|context)>/giu,
      "",
    )
    .trim();
}

function buildPreview(
  messages: readonly CodexImportedMessage[],
): ZCodeImportableSessionPreviewMessage[] {
  const firstUserIndex = messages.findIndex((message) => message.role === "user");
  if (firstUserIndex < 0) return [];
  const firstUser = messages[firstUserIndex]!;
  const firstAssistant = messages
    .slice(firstUserIndex + 1)
    .find((message) => message.role === "assistant");
  return [firstUser, ...(firstAssistant ? [firstAssistant] : [])].map((message) => ({
    role: message.role,
    content: truncatePreviewText(message.content),
  }));
}

async function parseCodexRolloutFile(filePath: string): Promise<CodexImportedSession | null> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header: Record<string, unknown> | undefined;
  const messages: CodexImportedMessage[] = [];
  let updatedAt: number | undefined;
  let model: string | undefined;
  try {
    for await (const line of lines) {
      if (!line.trim() || line.length > 2_000_000) continue;
      let record: Record<string, unknown> | undefined;
      try {
        record = object(JSON.parse(line));
      } catch {
        continue;
      }
      if (!record) continue;
      if (!header) {
        if (record.type !== "session_meta") return null;
        header = object(record.payload);
        continue;
      }
      const at = timestamp(record.timestamp);
      if (at !== undefined) updatedAt = Math.max(updatedAt ?? at, at);
      if (record.type === "turn_context") {
        const contextModel = object(record.payload)?.model;
        if (typeof contextModel === "string" && /^[A-Za-z0-9._/-]{1,80}$/u.test(contextModel)) {
          model = contextModel;
        }
      }
      if (record.type !== "response_item") continue;
      const payload = object(record.payload);
      if (payload?.type !== "message") continue;
      const role = payload.role;
      if (role !== "user" && role !== "assistant") continue;
      const rawContent = textContent(
        payload.content,
        role === "user" ? "input_text" : "output_text",
      );
      const content = role === "user" ? sanitizeCodexUserText(rawContent) : rawContent;
      if (!content) continue;
      messages.push({ role, content, ...(at === undefined ? {} : { timestamp: at }) });
    }
  } finally {
    lines.close();
    input.close();
  }

  const sessionId = typeof header?.session_id === "string" ? header.session_id.trim() : "";
  const workspacePath = typeof header?.cwd === "string" ? header.cwd.trim() : "";
  const createdAt = timestamp(header?.timestamp);
  if (!sessionId || !workspacePath || createdAt === undefined) return null;

  if (!messages.some((message) => message.role === "user")) return null;
  const firstUser = messages.find((message) => message.role === "user");
  const title = firstUser ? deriveSessionTitle(firstUser.content, []) : undefined;
  const headerModel =
    typeof header?.model === "string" && /^[A-Za-z0-9._/-]{1,80}$/u.test(header.model)
      ? header.model
      : undefined;
  model = headerModel ?? model;
  return {
    sessionId,
    workspacePath,
    createdAt,
    updatedAt: Math.max(createdAt, updatedAt ?? createdAt),
    ...(title ? { title } : {}),
    ...(model ? { model } : {}),
    messages,
  };
}

/** Parse only visible user/assistant text. Tool, reasoning, metadata and credential-shaped
 * fields are intentionally outside the AceVra imported-history contract. */
export async function parseCodexRollout(filePath: string): Promise<CodexImportedSession | null> {
  return parseCodexRolloutFile(filePath);
}

/** Scan-time preview derived from the same complete normalized projection as import. */
export async function parseCodexRolloutPreview(
  filePath: string,
): Promise<CodexRolloutPreview | null> {
  const session = await parseCodexRolloutFile(filePath);
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    workspacePath: session.workspacePath,
    createdAt: session.createdAt,
    title: session.title ?? session.sessionId.slice(0, 8),
    previewMessages: buildPreview(session.messages),
  };
}
