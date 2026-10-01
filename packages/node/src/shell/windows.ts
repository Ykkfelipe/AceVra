import { access } from "node:fs/promises";
import { win32 } from "node:path";

const { delimiter, isAbsolute, join } = win32;

const EXTENSIONS = [".exe", ".com", ".cmd", ".bat"];
/** Arguments to a batch file are passed through cmd.exe, so only a conservative alphabet is allowed. */
const BATCH_SAFE_ARG = /^[A-Za-z0-9_.,:=+@\\/ -]*$/;

export const isBatchFile = (path: string) => /\.(cmd|bat)$/i.test(path);

/** Windows spawn(shell:false) does not apply PATHEXT: resolve `pnpm` → `pnpm.cmd` ourselves. */
export async function resolveWindowsExecutable(
  executable: string,
  env: Record<string, string>,
  exists: (p: string) => Promise<boolean> = (p) =>
    access(p).then(
      () => true,
      () => false,
    ),
): Promise<string | null> {
  const hasExt = /\.[A-Za-z0-9]{1,4}$/.test(executable);
  const candidates = (base: string) => (hasExt ? [base] : EXTENSIONS.map((ext) => base + ext));
  if (isAbsolute(executable) || /[\\/]/.test(executable)) {
    for (const c of candidates(executable)) if (await exists(c)) return c;
    return null;
  }
  const path = env.Path ?? env.PATH ?? "";
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const c of candidates(join(dir, executable))) if (await exists(c)) return c;
  }
  return null;
}

/** Builds the cmd.exe invocation for a batch file, or null if any argument could inject. */
export function buildBatchInvocation(batchPath: string, args: string[], comspec = "cmd.exe") {
  if (!args.every((a) => BATCH_SAFE_ARG.test(a)) || /["%^&|<>()!\r\n]/.test(batchPath)) return null;
  const quote = (v: string) => (/\s/.test(v) ? `"${v}"` : v);
  return {
    command: comspec,
    args: ["/d", "/s", "/c", `"${[quote(batchPath), ...args.map(quote)].join(" ")}"`],
    windowsVerbatimArguments: true,
  };
}
