#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const handoff = arg("--handoff");
const app = arg("--app");
if (!handoff || !app) throw new Error("--handoff and --app are required");
if (!existsSync(handoff) || !existsSync(app))
  throw new Error("handoff and installed app are required");
if (
  resolve(handoff).split("/").includes("build") ||
  resolve(handoff).split("/").includes("validation")
)
  throw new Error("raw build/validation directories are not accepted");
const entries = readdirSync(handoff).sort();
const expected = [
  `AceVra-${version}-arm64.dmg`,
  `AceVra-${version}-arm64.zip`,
  "build-info.json",
  "RELEASE_NOTES.md",
  "SHA256SUMS.txt",
].sort();
if (entries.join("\n") !== expected.join("\n"))
  throw new Error("handoff is not the exact five-file candidate");
const target = lstatSync(app);
if (target.isSymbolicLink()) throw new Error("installed app target must not be a symlink");
console.log(
  `[installed] static handoff evidence present for ${version}; human checkpoints remain required`,
);
