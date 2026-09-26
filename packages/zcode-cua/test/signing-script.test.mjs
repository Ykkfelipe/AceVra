import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";

const signingScript = fileURLToPath(
  new URL("../native/cua-helper/signing/create-dev-signing-identity.sh", import.meta.url),
);
const temporaryDirectories = new Set();

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function runSigningScript(overrides = {}, withExistingIdentity = false) {
  const directory = mkdtempSync(join(tmpdir(), "acevra-signing-script-test-"));
  temporaryDirectories.add(directory);
  const fakeBin = join(directory, "bin");
  mkdirSync(fakeBin);
  const trustState = join(directory, "trusted");
  const unlockedState = join(directory, "unlocked");
  const calls = join(directory, "calls");
  const signingDirectory = join(directory, "signing");
  if (withExistingIdentity) {
    mkdirSync(signingDirectory);
    writeFileSync(join(signingDirectory, "acevra-cua-dev.keychain-db"), "existing-keychain");
    writeFileSync(join(signingDirectory, "keychain-password"), "test-password", { mode: 0o600 });
  }
  const fakeSecurity = join(fakeBin, "security");
  writeFileSync(
    fakeSecurity,
    `#!/bin/sh
set -eu
command="$1"
printf '%s\\n' "$command" >> "$SIGNING_TEST_CALLS"
case "$command" in
  find-identity)
    if [ -f "$SIGNING_TEST_UNLOCKED_STATE" ] && [ -f "$SIGNING_TEST_TRUST_STATE" ] && [ "\${SIGNING_TEST_EMPTY_FINAL:-0}" != "1" ]; then
      printf '  1) 94C291547ACD96A490A0169CE5924AE1F71D4645 "AceVra CUA Dev Signing"\\n     1 valid identities found\\n'
    else
      printf '     0 valid identities found\\n'
    fi
    ;;
  unlock-keychain)
    : > "$SIGNING_TEST_UNLOCKED_STATE"
    ;;
  find-certificate)
    printf 'existing certificate fixture\\n'
    ;;
  import)
    [ "\${SIGNING_TEST_FAIL_AT:-}" != "import" ] || exit 19
    echo '1 identity imported.'
    ;;
  set-key-partition-list)
    [ "\${SIGNING_TEST_FAIL_AT:-}" != "partition" ] || exit 20
    ;;
  add-trusted-cert)
    [ "\${SIGNING_TEST_FAIL_AT:-}" != "trust" ] || exit 21
    [ "\${SIGNING_TEST_EMPTY_FINAL:-0}" = "1" ] || : > "$SIGNING_TEST_TRUST_STATE"
    ;;
  create-keychain)
    for target do :; done
    : > "$target"
    ;;
  *)
    ;;
esac
`,
    { mode: 0o700 },
  );
  chmodSync(fakeSecurity, 0o700);
  const result = spawnSync("/bin/bash", [signingScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      CUA_SIGNING_DIR: join(directory, "signing"),
      SIGNING_TEST_TRUST_STATE: trustState,
      SIGNING_TEST_UNLOCKED_STATE: unlockedState,
      SIGNING_TEST_CALLS: calls,
      ...overrides,
    },
  });
  return { ...result, calls: readFileSync(calls, "utf8").trim().split("\n"), directory };
}

describe("development signing identity script", () => {
  it("requires exactly one expected identity after certificate trust is configured", () => {
    const result = runSigningScript();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 valid identities found/);
    assert.match(result.stdout, /AceVra CUA Dev Signing/);
  });

  it("unlocks and restores trust before reusing an existing locked identity", () => {
    const result = runSigningScript({}, true);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.calls, [
      "unlock-keychain",
      "find-certificate",
      "add-trusted-cert",
      "find-identity",
    ]);
    assert.match(result.stdout, /94C291547ACD96A490A0169CE5924AE1F71D4645 "AceVra CUA Dev Signing"/);
    assert.match(result.stdout, /1 valid identities found/);
    assert.doesNotMatch(result.calls.join("\n"), /create-keychain|import/);
  });

  it("fails when PKCS#12 import or key access configuration fails", () => {
    for (const step of ["import", "partition", "trust"]) {
      const result = runSigningScript({ SIGNING_TEST_FAIL_AT: step });
      assert.notEqual(result.status, 0, `${step} failure must fail the script`);
    }
  });

  it("fails instead of reporting success when identity discovery returns zero", () => {
    const result = runSigningScript({ SIGNING_TEST_EMPTY_FINAL: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /expected exactly one valid/);
  });
});
