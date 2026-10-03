/**
 * 宿主侧装配：把文件 store 与专用 Bot workspace 接到 botService。
 * node-only（依赖 node:fs），因此只从 @zcode/services/node 导出。
 */
import type { IBotService } from "../contract.js";
import { createBotService } from "../app/botService.js";
import { getPersonalBotRootDir, getPersonalBotWorkspaceDir } from "../../paths.js";
import { createFileBotStore } from "./fileBotStore.js";

export interface CreateNodeBotServiceOptions {
  /** 覆盖数据根（测试用）。 */
  rootDir?: string;
  /** 覆盖 Bot workspace 路径（测试用）。 */
  workspacePath?: string;
}

export function createNodeBotService(options: CreateNodeBotServiceOptions = {}): IBotService {
  const workspacePath = options.workspacePath ?? getPersonalBotWorkspaceDir();
  return createBotService({
    store: createFileBotStore({ rootDir: options.rootDir ?? getPersonalBotRootDir() }),
    // 本地 Bot workspace 无独立 identity，workspaceKey 与路径一致。
    workspace: { path: workspacePath, key: workspacePath },
  });
}
