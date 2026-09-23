import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { deriveSessionTitle } from "#src/session/sessionTitle.js";

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

/** Parse only visible user/assistant text. Tool, reasoning, metadata and credential-shaped
 * fields are intentionally outside the AceVra imported-history contract. */
export async function parseCodexRollout(filePath: string): Promise<CodexImportedSession | null> {
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
      const content = textContent(payload.content, role === "user" ? "input_text" : "output_text");
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
  if (!sessionId || !workspacePath || createdAt === undefined || messages.length === 0) return null;
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
