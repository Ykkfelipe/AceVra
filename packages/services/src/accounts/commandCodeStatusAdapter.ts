/**
 * Command Code account/usage status via its supported CLI surface.
 *
 * SUPPORTED SURFACE, established by inspecting the installed CLI (v1.62.1):
 *
 *   `commandcode status --json`   documented flag: "Output status as JSON for automation"
 *   -> {"authenticated":bool,"version":str,"user":str,"model":str,"context_window":int}
 *
 * Deliberately NOT used:
 * - `commandcode whoami` ignores `--json` and prints human-readable text only.
 * - The `/usage` slash command (credits/plan/usage metrics) is an interactive overlay. Run
 *   headlessly it replies that it "can't run in a headless/non-interactive turn" and points
 *   at a web view. Scraping that web view is out of scope by instruction, so plan and
 *   quota figures are reported as UNAVAILABLE rather than invented or inferred.
 *
 * SECURITY: never reads `~/.commandcode/auth.json` and never returns the API key. Only the
 * fields above are surfaced.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Exactly the fields the documented JSON contract provides. */
export interface CommandCodeStatus {
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly version?: string;
  readonly user?: string;
  readonly defaultModel?: string;
  readonly contextWindow?: number;
  /**
   * True when plan/usage metrics could not be obtained from a supported non-interactive
   * surface. The UI must show "not available" rather than guessing.
   */
  readonly usageUnavailable: true;
  readonly usageUnavailableReason: string;
  readonly error?: string;
  readonly checkedAt: string;
}

const USAGE_UNAVAILABLE_REASON =
  "Command Code exposes plan and usage metrics only through the interactive /usage overlay; no supported non-interactive CLI surface returns them.";

/** Parse the documented `status --json` payload. Exported for direct unit testing. */
export function parseCommandCodeStatusJson(raw: string): {
  authenticated: boolean;
  version?: string;
  user?: string;
  defaultModel?: string;
  contextWindow?: number;
} {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return {
    authenticated: parsed.authenticated === true,
    ...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
    ...(typeof parsed.user === "string" ? { user: parsed.user } : {}),
    ...(typeof parsed.model === "string" ? { defaultModel: parsed.model } : {}),
    ...(typeof parsed.context_window === "number" ? { contextWindow: parsed.context_window } : {}),
  };
}

export async function readCommandCodeStatus(
  executable = "commandcode",
): Promise<CommandCodeStatus> {
  const checkedAt = new Date().toISOString();
  const unavailable = {
    usageUnavailable: true as const,
    usageUnavailableReason: USAGE_UNAVAILABLE_REASON,
    checkedAt,
  };
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(executable, ["status", "--json"], {
      timeout: 30_000,
      maxBuffer: 512 * 1024,
    }));
  } catch (error) {
    const fallback = (error as { stdout?: string }).stdout;
    if (typeof fallback === "string" && fallback.trim()) {
      stdout = fallback;
    } else {
      return { installed: false, authenticated: false, ...unavailable };
    }
  }
  try {
    // The CLI may emit progress lines before the JSON; take the last JSON-looking line.
    const line = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{") && l.endsWith("}"))
      .pop();
    if (!line) {
      return { installed: true, authenticated: false, error: "unparsable_status", ...unavailable };
    }
    return { installed: true, ...parseCommandCodeStatusJson(line), ...unavailable };
  } catch {
    return { installed: true, authenticated: false, error: "unparsable_status", ...unavailable };
  }
}
