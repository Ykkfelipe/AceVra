import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const fold = (p: string) =>
  process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p;

/** True if `child` is `root` or inside it (segment-aware, symlinks already resolved). */
export function isInside(root: string, child: string): boolean {
  const rel = relative(fold(root), fold(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

/** Canonicalizes allowed roots (they must exist). */
export async function resolveRoots(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) out.push(await realpath(resolve(root)));
  return out;
}

/** The cwd must be an existing absolute directory inside an allowed root (after symlinks). */
export async function resolveCwd(cwd: string, roots: string[]): Promise<string | null> {
  if (!isAbsolute(cwd) || roots.length === 0) return null;
  try {
    const real = await realpath(cwd);
    return roots.some((root) => isInside(root, real)) ? real : null;
  } catch {
    return null;
  }
}
