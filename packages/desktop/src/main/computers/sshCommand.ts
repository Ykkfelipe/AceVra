import type { ChildProcess, SpawnOptions } from "node:child_process";

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Options shared by every ssh invocation: never prompt (the user's keys/agent only). */
export const SSH_BASE_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
] as const;

export const WORKER_TOKEN_PATH = "C:\\ProgramData\\AceVra\\worker-token.txt";

/** Encodes a PowerShell script for `-EncodedCommand` (UTF-16LE base64): no quoting through ssh. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function powershellArgs(script: string): string[] {
  return [
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encodePowerShell(script),
  ];
}

export interface SshResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** One bounded ssh command (health probe, token read). Output is capped; stderr never logged raw. */
export function runSsh(
  spawn: SpawnFn,
  hostAlias: string,
  remoteArgs: string[],
  timeoutMs = 20_000,
): Promise<SshResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ChildProcess;
    try {
      child = spawn("ssh", [...SSH_BASE_OPTIONS, hostAlias, ...remoteArgs], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({ code: null, stdout: "", stderr: "spawn_failed" });
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 64_000) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString("utf8");
    });
    child.on("error", () => undefined);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Reads the worker token over SSH. The value is returned to memory only and never logged. */
export async function fetchWorkerToken(spawn: SpawnFn, hostAlias: string): Promise<string | null> {
  const result = await runSsh(
    spawn,
    hostAlias,
    powershellArgs(`[IO.File]::ReadAllText('${WORKER_TOKEN_PATH}').Trim()`),
  );
  const token = result.stdout.trim();
  return result.code === 0 && /^[A-Za-z0-9_-]{16,256}$/.test(token) ? token : null;
}

/** Maps ssh stderr to a short reason without echoing it (it may contain host details). */
export function classifySshFailure(stderr: string): string {
  if (/Permission denied|publickey/i.test(stderr)) return "auth_failed";
  if (/Could not resolve|Name or service not known|nodename nor servname/i.test(stderr))
    return "host_unknown";
  if (/timed out|Connection refused|No route|Network is unreachable/i.test(stderr))
    return "unreachable";
  if (/forwarding failed|Address already in use/i.test(stderr)) return "forward_failed";
  return "ssh_failed";
}
