import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyCommandCodeReasoningCapabilitiesToPersonalConfig } from "../packages/provider/src/command-code-reasoning-capabilities.ts";
import { decodeProviderConfigFile } from "../packages/provider-node/src/provider-config-file-codec.ts";
import { atomicWritePrivateTextFile } from "../packages/shared/src/node/privateFilePersistence.ts";

const configPath = join(homedir(), ".zcode", "v2", "provider_config.json");
const source = await readFile(configPath, "utf8");
const next = applyCommandCodeReasoningCapabilitiesToPersonalConfig(JSON.parse(source));

// Validate the exact serialized shape before the single atomic write. This script owns only the
// reviewed Command Code reasoning option specs; provider credentials and all other rules pass
// through unchanged.
decodeProviderConfigFile(next);
const serialized = `${JSON.stringify(next, null, 2)}\n`;
if (serialized === source) {
  console.log("Command Code reasoning capabilities already synchronized.");
} else {
  await atomicWritePrivateTextFile(configPath, serialized);
  console.log("Synchronized 29 Command Code reasoning capability rules.");
}
