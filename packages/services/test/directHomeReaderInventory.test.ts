// Direct-HOME reader inventory.
//
// Run: mise exec -- node --import tsx --test packages/services/test/directHomeReaderInventory.test.ts
//
// A behavioural test cannot import all of these services cheaply (their constructors open
// databases and network clients), so the inventory is asserted at the source boundary that
// actually decides isolation: each reader resolves the user home through getUserHomeDir() and
// must not fall back to `process.env.HOME` on its own. A new reader added without that import
// fails here, which is the point.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const READER_FILES = [
  "src/commands/commandsService.ts",
  "src/skills/skillsService.ts",
  "src/settings-sync/settingsSyncService.ts",
  "src/skill-sync/skillSyncService.ts",
  "src/subagents/subagentStorage.ts",
  "src/hooks/hooksService.ts",
  "src/plugin-sync/pluginSyncService.ts",
  "src/cua-permission-broker/darwinCuaHelperTransport.ts",
  "src/mcp-sync/mcpSyncService.ts",
  "src/zcode-agent/modelTrajectoryFileTail.ts",
];

for (const relative of READER_FILES) {
  test(`${relative} resolves user home through the canonical helper`, async () => {
    const source = await readFile(new URL(`../${relative}`, import.meta.url), "utf8");
    assert.match(source, /getUserHomeDir/);
    assert.doesNotMatch(source, /homedir\(\)/);
    assert.doesNotMatch(source, /process\.env\.HOME\?\.trim\(\)/);
    assert.doesNotMatch(source, /process\.env\.USERPROFILE\?\.trim\(\)/);
  });
}

test("global CLI config resolution uses the canonical helper", async () => {
  const source = await readFile(new URL("../src/node.ts", import.meta.url), "utf8");
  assert.match(source, /hasGlobalCliZCodeCuaServer[\s\S]*getUserHomeDir\(env\)/);
  assert.doesNotMatch(source, /hasGlobalCliZCodeCuaServer[\s\S]{0,200}env\.HOME/);
});
