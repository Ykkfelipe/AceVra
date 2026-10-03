import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const dir = resolve(import.meta.dirname);

/**
 * Signing out of an AceVra account must not delete user data.
 *
 * The behaviour is currently correct — the account feature contains no filesystem
 * removal at all, so the only local writes are the installation id, the local-mode
 * preference and Clerk's own OS-encrypted token store. That property is load-bearing
 * (it is what makes "Continue locally" safe and what the desktop E2E asserts against
 * `provider_config.json`), and it is easy to break by accident: adding a cleanup step
 * that looks local but removes conversations, provider config or workspace state.
 *
 * This is a structural guard rather than a behavioural one, so it catches the mistake
 * at the point it is introduced instead of only when the affected path is exercised.
 */

/** Removal primitives. `truncated`-style property names are not matched. */
const DESTRUCTIVE = [
  /\brmSync\s*\(/,
  /\brm\s*\(/,
  /\bunlinkSync\s*\(/,
  /\bunlink\s*\(/,
  /\brmdirSync\s*\(/,
  /\brmdir\s*\(/,
  /\btruncateSync\s*\(/,
  /\btruncate\s*\(/,
  /\bcp\s*\(\s*\{[^}]*recursive/,
  /\bpromises\s*\.\s*rm\b/,
];

test("the account feature never deletes user data", async () => {
  const offenders: Array<{ file: string; match: string }> = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (/\.(test|spec)\.[cm]?ts$/.test(entry.name)) continue;
    const source = await readFile(join(dir, entry.name), "utf8");
    for (const pattern of DESTRUCTIVE) {
      const hit = pattern.exec(source);
      if (hit) offenders.push({ file: entry.name, match: hit[0] });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "account sign-out is documented as non-destructive; no removal primitive belongs here",
  );
});

test("the account feature only writes the two files it owns", async () => {
  // Guards the positive side of the same invariant: an allowlist of the local paths
  // the account feature is permitted to write. A new write target must be a
  // deliberate decision, reviewed, rather than a side effect of a feature.
  const writes = new Map<string, string[]>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (/\.(test|spec)\.[cm]?ts$/.test(entry.name)) continue;
    const source = await readFile(join(dir, entry.name), "utf8");
    const paths = [...source.matchAll(/"(acevra-[a-z-]+\.json)"/g)].map((m) => m[1]!);
    for (const p of paths) writes.set(p, [...(writes.get(p) ?? []), entry.name]);
  }
  const owned = [...writes.keys()].sort();
  assert.deepEqual(owned, ["acevra-account.json", "acevra-installation.json"]);
});
