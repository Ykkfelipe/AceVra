import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const FORK_USER_ID = "user_3Jf3aAXOGiPHUSjYDqLcGTmmYRe";
const FORK_RELAY_TOKEN = "local-relay-development-token";

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function createCustomForkDevEnvironment(env = process.env, home = homedir()) {
  const explicitDataBaseDir = nonEmpty(env.ZCODE_DATA_BASE_DIR);
  const explicitDesktopHome = nonEmpty(env.ZCODE_DESKTOP_HOME_DIR);
  const explicitZcodeHome = nonEmpty(env.ZCODE_HOME);
  const zcodeHomeBase = explicitZcodeHome && basename(resolve(explicitZcodeHome)) === ".zcode"
    ? dirname(resolve(explicitZcodeHome))
    : undefined;
  const dataBaseDir =
    explicitDataBaseDir ??
    explicitDesktopHome ??
    zcodeHomeBase ??
    join(home, ".zcode-fork-dev-home");

  return {
    ...env,
    ZCODE_FORK_DEV: "1",
    ZCODE_DATA_BASE_DIR: dataBaseDir,
    ZCODE_DESKTOP_HOME_DIR: explicitDesktopHome ?? dataBaseDir,
    ZCODE_HOME: explicitZcodeHome ?? join(dataBaseDir, ".zcode"),
    ZCODE_FORK_SERVER_MODE: "relay-broker",
    ZCODE_FORK_ALLOWED_CLERK_USER_IDS: nonEmpty(env.ZCODE_FORK_ALLOWED_CLERK_USER_IDS) ?? FORK_USER_ID,
    ZCODE_FORK_CLERK_AUTHORIZED_PARTIES:
      nonEmpty(env.ZCODE_FORK_CLERK_AUTHORIZED_PARTIES) ?? "http://localhost:5173",
    ZCODE_FORK_RELAY_URL: nonEmpty(env.ZCODE_FORK_RELAY_URL) ?? "ws://localhost:3030",
    ZCODE_FORK_RELAY_DEVICE_TOKEN:
      nonEmpty(env.ZCODE_FORK_RELAY_DEVICE_TOKEN) ?? FORK_RELAY_TOKEN,
  };
}
