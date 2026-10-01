import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface NodePaths {
  root: string;
  key: string;
  state: string;
  status: string;
  logs: string;
}

/** Node-owned state lives in its own root, never in a desktop profile. */
export function resolveNodePaths(env: NodeJS.ProcessEnv = process.env): NodePaths {
  const root = env.ACEVRA_NODE_HOME?.trim() || join(homedir(), ".acevra-node");
  return {
    root,
    key: join(root, "key.pem"),
    state: join(root, "node.json"),
    status: join(root, "status.json"),
    logs: join(root, "logs"),
  };
}

/** Creates the root with owner-only permissions (POSIX). */
export async function ensureNodeRoot(paths: NodePaths): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await mkdir(paths.logs, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(paths.root, 0o700);
    await chmod(paths.logs, 0o700);
  }
}
