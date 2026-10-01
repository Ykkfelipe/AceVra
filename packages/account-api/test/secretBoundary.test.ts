import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const repo = resolve(import.meta.dirname, "../../..");
// Code that ships into, or is reachable from, the renderer or preload.
const rendererReachable = [
  "packages/ui/src",
  "packages/shared/src/account.ts",
  "packages/desktop/src/renderer",
  "packages/desktop/src/preload",
];
const forbidden =
  /ACEVRA_CLERK_SECRET_KEY|ACEVRA_CLERK_JWT_KEY|ACEVRA_DATABASE_URL|CLERK_SECRET_KEY|sk_(test|live)_[A-Za-z0-9]/;

async function* files(path: string): AsyncGenerator<string> {
  const stat = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (!stat) return void (yield path);
  for (const entry of stat) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    yield* files(join(path, entry.name));
  }
}

test("renderer/preload-reachable source never references backend secrets", async () => {
  const offenders: string[] = [];
  for (const root of rendererReachable) {
    for await (const file of files(join(repo, root))) {
      if (!/\.(tsx?|mjs|html)$/.test(file)) continue;
      if (forbidden.test(await readFile(file, "utf8"))) offenders.push(file.replace(repo, ""));
    }
  }
  assert.deepEqual(offenders, []);
});

test("the Account window only ever receives the public publishable key", async () => {
  const source = await readFile(
    join(repo, "packages/desktop/src/main/account/accountWindowTokenSource.ts"),
    "utf8",
  );
  assert.match(source, /return \{ publishableKey: options\.publishableKey \}/);
});
