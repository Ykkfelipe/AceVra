#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const required = [`AceVra-${version}-arm64.dmg`, `AceVra-${version}-arm64.zip`];
const sidecars = ["build-info.json", "RELEASE_NOTES.md", "SHA256SUMS.txt"];

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
const validation = resolve(
  arg("--validation-dir", join(root, "release", "0.1.0-alpha.1", "validation")),
);
const handoff = resolve(arg("--handoff-dir", join(root, "release", "0.1.0-alpha.1", "handoff")));
if (!existsSync(validation) || existsSync(handoff))
  throw new Error("validation/handoff directory missing or handoff already exists");
const staging = `${handoff}.staging-${process.pid}`;
mkdirSync(staging);
for (const name of [...required, ...sidecars]) {
  const source = join(validation, name);
  if (!existsSync(source)) throw new Error(`validation fixture is missing ${name}`);
  if (required.includes(name)) writeFileSync(join(staging, name), readFileSync(source));
}
writeFileSync(join(staging, "build-info.json"), readFileSync(join(validation, "build-info.json")));
writeFileSync(
  join(staging, "RELEASE_NOTES.md"),
  `# AceVra ${version}\n\nSelf-signed, non-notarized local engineering alpha. No Developer ID or public distribution claim.\n`,
);
writeFileSync(
  join(staging, "SHA256SUMS.txt"),
  required.map((name) => `${sha256(join(staging, name))}  ${name}`).join("\n") + "\n",
);
const actual = readdirSync(staging).sort();
const expected = [...required, ...sidecars].sort();
if (actual.join("\n") !== expected.join("\n"))
  throw new Error(`handoff file allowlist mismatch: ${actual.join(", ")}`);
for (const line of readFileSync(join(staging, "SHA256SUMS.txt"), "utf8").trim().split("\n")) {
  const [digest, name] = line.split("  ");
  if (sha256(join(staging, name)) !== digest) throw new Error(`checksum mismatch: ${name}`);
}
renameSync(staging, handoff);
console.log(`[handoff] assembled ${handoff}`);
