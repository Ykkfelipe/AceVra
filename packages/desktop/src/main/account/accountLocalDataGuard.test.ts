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
  // Deletion via a spawned shell. `accountMain.ts` already imports execFile, so
  // `execFile("rm", ["-rf", path])` would otherwise sail past every check above.
  /execFile(?:Sync)?\s*\(\s*["'`]\s*(?:rm|rmdir|shred|unlink|find)\b/,
  /\bspawn(?:Sync)?\s*\(\s*["'`]\s*(?:rm|rmdir|shred|unlink)\b/,
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

const OWNED = new Set(["acevra-account.json", "acevra-installation.json"]);

/**
 * A quoted filename with a data-ish extension. Deliberately broad: matching only
 * `acevra-*.json` let `"conversations.json"` through, which is literally the example
 * this guard exists to catch.
 */
const FILENAME = /["'`]([\w.-]+\.(?:json|jsonl|db|sqlite|sqlite3|log|txt|md))["'`]/g;

test("the account feature only writes the two files it owns", async () => {
  // Guards the positive side of the same invariant: an allowlist of the local paths the
  // account feature may write. A new write target must be a deliberate, reviewed
  // decision rather than a side effect of a feature.
  const offenders: Array<{ file: string; path: string }> = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (/\.(test|spec)\.[cm]?ts$/.test(entry.name)) continue;
    const source = await readFile(join(dir, entry.name), "utf8");
    for (const match of source.matchAll(FILENAME)) {
      const value = match[1]!;
      // Only basenames that look like local state files, not npm package specifiers.
      if (value.startsWith("@") || /^[a-z-]+$/.test(value)) continue;
      if (!OWNED.has(value)) offenders.push({ file: entry.name, path: value });
    }
  }
  assert.deepEqual(offenders, [], "the account feature may only write its own two files");
});
