import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const SERVICE_HOOKS = [
  "useZCodeAgentService.ts",
  "useZCodeSessionService.ts",
  "useZCodeTaskService.ts",
] as const;

test("onboarding service hooks resolve workspace accessors through one unconditional hook path", async () => {
  for (const file of SERVICE_HOOKS) {
    const source = await readFile(new URL(`../src/hooks/${file}`, import.meta.url), "utf8");
    assert.match(source, /useResolvedServiceAccessor\(/u, file);
    assert.doesNotMatch(source, /workspacePath\s*\?\s*useWorkspaceServices/u, file);
  }
});
