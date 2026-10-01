/**
 * The structured process contract (no shell string, no interpolation). Validated by the
 * control plane on creation and again by the node on offer; each side trusts nothing.
 */
export interface ProcessSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export const MAX_SPEC_BYTES = 8192;
export const DEFAULT_TIMEOUT_MS = 600_000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 3_600_000;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
// Names that change how programs are located/loaded are never caller-controlled.
const ENV_DENY =
  /^(PATH|PATHEXT|COMSPEC|NODE_OPTIONS|LD_.*|DYLD_.*|PYTHONPATH|PYTHONHOME|PERL5LIB|RUBYLIB|ACEVRA_.*)$/;

const clean = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max && !value.includes("\0");

export function parseProcessSpec(input: unknown): ProcessSpec | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const allowed = new Set(["executable", "args", "cwd", "env", "timeoutMs"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
  if (!clean(raw.executable, 260) || /[\r\n]/.test(raw.executable)) return null;
  const args = raw.args ?? [];
  if (!Array.isArray(args) || args.length > 64) return null;
  for (const arg of args) {
    if (typeof arg !== "string" || arg.length > 2048 || arg.includes("\0")) return null;
  }
  if (!clean(raw.cwd, 512)) return null;
  const env: Record<string, string> = {};
  const rawEnv = raw.env ?? {};
  if (!rawEnv || typeof rawEnv !== "object" || Array.isArray(rawEnv)) return null;
  const entries = Object.entries(rawEnv as Record<string, unknown>);
  if (entries.length > 16) return null;
  for (const [name, value] of entries) {
    if (!ENV_NAME.test(name) || ENV_DENY.test(name)) return null;
    if (typeof value !== "string" || value.length > 1024 || value.includes("\0")) return null;
    env[name] = value;
  }
  const timeoutMs = raw.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    return null;
  }
  const spec: ProcessSpec = {
    executable: raw.executable,
    args: args as string[],
    cwd: raw.cwd,
    env,
    timeoutMs,
  };
  return JSON.stringify(spec).length <= MAX_SPEC_BYTES ? spec : null;
}
