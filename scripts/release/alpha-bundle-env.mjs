import { resolve } from "node:path";

export function resolveAlphaBundleEnv(env = process.env, root = process.cwd()) {
  const releaseRoot = resolve(root, "release", "0.1.0-alpha.1");
  return {
    ...env,
    ZCODE_DESKTOP_RELEASE_PROFILE: "local-engineering-alpha",
    ZCODE_DESKTOP_DIST_DIR: resolve(releaseRoot, "build"),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const env = resolveAlphaBundleEnv();
  const command = args[0];
  if (!command) throw new Error("expected a command to run in the alpha environment");
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(command, args.slice(1), { env, stdio: "inherit" });
  process.exit(result.status ?? 1);
}
