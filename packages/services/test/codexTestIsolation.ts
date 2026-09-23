import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Establish an isolated Codex home before any test file imports account or history modules.
const isolatedCodexHome = await mkdtemp(join(tmpdir(), "zcode-codex-test-home-"));
const previousCodexHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = isolatedCodexHome;

export async function cleanupCodexTestIsolation(): Promise<void> {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  await rm(isolatedCodexHome, { recursive: true, force: true });
}

export function getIsolatedCodexHome(): string {
  return isolatedCodexHome;
}
