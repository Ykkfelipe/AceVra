/**
 * The structured process contract the node accepts. Re-validated here even though the control
 * plane validated it: the node trusts nothing it receives.
 */
export interface ProcessSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ENV_DENY =
  /^(PATH|PATHEXT|COMSPEC|NODE_OPTIONS|LD_.*|DYLD_.*|PYTHONPATH|PYTHONHOME|PERL5LIB|RUBYLIB|ACEVRA_.*)$/;
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length >= 1 && v.length <= max && !v.includes("\0");

export function parseProcessSpec(input: unknown): ProcessSpec | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((k) => !["executable", "args", "cwd", "env", "timeoutMs"].includes(k)))
    return null;
  if (!text(raw.executable, 260) || /[\r\n]/.test(raw.executable)) return null;
  const args = raw.args ?? [];
  if (!Array.isArray(args) || args.length > 64) return null;
  if (!args.every((a) => typeof a === "string" && a.length <= 2048 && !a.includes("\0")))
    return null;
  if (!text(raw.cwd, 512)) return null;
  const rawEnv = raw.env ?? {};
  if (!rawEnv || typeof rawEnv !== "object" || Array.isArray(rawEnv)) return null;
  const env: Record<string, string> = {};
  const entries = Object.entries(rawEnv as Record<string, unknown>);
  if (entries.length > 16) return null;
  for (const [name, value] of entries) {
    if (!ENV_NAME.test(name) || ENV_DENY.test(name)) return null;
    if (typeof value !== "string" || value.length > 1024 || value.includes("\0")) return null;
    env[name] = value;
  }
  const timeoutMs = raw.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 3_600_000
  )
    return null;
  return { executable: raw.executable, args: args as string[], cwd: raw.cwd, env, timeoutMs };
}

/** Variables a child may inherit. Everything else — notably ACEVRA_* and any token — is withheld. */
const BASE_ENV = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "ComSpec",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "COMPUTERNAME",
];
export function buildChildEnv(
  additions: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
) {
  const env: Record<string, string> = {};
  for (const name of BASE_ENV) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...additions, NO_COLOR: "1" };
}
