export function resolveWindowBoundsTargets(env = process.env) {
  return env.ZCODE_DESKTOP_RELEASE_PROFILE?.trim().toLowerCase() === "local-engineering-alpha"
    ? ["arm64-apple-macos11"]
    : ["arm64-apple-macos11", "x86_64-apple-macos11"];
}
