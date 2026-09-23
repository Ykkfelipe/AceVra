import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve an explicitly configured binary first, then PATH and standard per-user installs. */
export function discoverExecutable(params: {
  name: string;
  configuredPath?: string;
  pathValue?: string;
  extraCandidates?: readonly string[];
}): string | undefined {
  const configured = params.configuredPath?.trim();
  if (configured) return isExecutable(configured) ? configured : undefined;

  const pathEntries = (params.pathValue ?? process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((entry) => join(entry, params.name));
  const home = homedir();
  const candidates = [
    ...pathEntries,
    ...(params.extraCandidates ?? []).map((path) => path.replace(/^~/u, home)),
  ];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}
