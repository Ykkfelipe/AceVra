import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  resolveCodexExecutable,
  getCodexExecutableCandidates,
} from "../src/accounts/codexAppServerBridge.js";
import { discoverExecutable } from "../src/accounts/executableDiscovery.js";

async function makeExecutable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
}

test("Codex discovery includes the current ChatGPT bundle CLI and the legacy bundle path", () => {
  const candidates = getCodexExecutableCandidates({
    applicationsDirectory: "/Applications",
    homeDirectory: "/Users/tester",
  });

  assert.equal(candidates[0], "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
  assert.equal(
    candidates[1],
    "/Users/tester/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  );
  assert.ok(candidates.includes("/Applications/ChatGPT.app/Contents/Resources/codex"));
  assert.ok(candidates.includes("/Users/tester/Applications/ChatGPT.app/Contents/Resources/codex"));
});

test("Codex discovery finds the ChatGPT bundle candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-discovery-"));
  try {
    const candidates = getCodexExecutableCandidates({
      applicationsDirectory: join(root, "Applications"),
      homeDirectory: join(root, "home"),
    });
    await makeExecutable(candidates[0]!);

    assert.equal(
      discoverExecutable({ name: "codex", pathValue: "", extraCandidates: candidates }),
      candidates[0],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex discovery preserves PATH, ~/.local/bin, and ~/.cargo/bin candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-discovery-"));
  try {
    const pathDirectory = join(root, "path");
    const homeDirectory = join(root, "home");
    const candidates = getCodexExecutableCandidates({
      applicationsDirectory: join(root, "Applications"),
      homeDirectory,
    });
    const localCandidate = join(homeDirectory, ".local", "bin", "codex");
    const cargoCandidate = join(homeDirectory, ".cargo", "bin", "codex");

    await makeExecutable(join(pathDirectory, "codex"));
    await makeExecutable(localCandidate);
    await makeExecutable(cargoCandidate);

    assert.equal(
      discoverExecutable({ name: "codex", pathValue: pathDirectory, extraCandidates: candidates }),
      join(pathDirectory, "codex"),
    );
    assert.equal(
      discoverExecutable({ name: "codex", pathValue: "", extraCandidates: candidates }),
      localCandidate,
    );
    await rm(localCandidate);
    assert.equal(
      discoverExecutable({ name: "codex", pathValue: "", extraCandidates: candidates }),
      cargoCandidate,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex discovery reports missing executables and preserves explicit-path priority", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-discovery-"));
  try {
    const explicitPath = join(root, "configured", "codex");
    const pathCandidate = join(root, "path", "codex");
    await makeExecutable(explicitPath);
    await makeExecutable(pathCandidate);

    assert.equal(resolveCodexExecutable(explicitPath), explicitPath);
    assert.equal(discoverExecutable({ name: "codex", pathValue: join(root, "empty") }), undefined);
    assert.equal(
      discoverExecutable({
        name: "codex",
        configuredPath: explicitPath,
        pathValue: dirname(pathCandidate),
      }),
      explicitPath,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
