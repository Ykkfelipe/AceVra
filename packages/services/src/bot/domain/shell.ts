/**
 * Bot 对话外壳：纯函数，无 IO。
 *
 * 外壳只记录“Bot 的对话落在哪个 workspace、上次打开的是哪个 session”。
 * 消息/轮次属于 CLI AgentRuntime + session store，本模块绝不写入会话内容——
 * 身份与对话状态必须保持分离（M1 spec §2、§5）。
 */

export interface BotConversationShell {
  /** 专用 Bot workspace 路径；永远不是用户仓库。文件操作/Git/cwd 用这个值。 */
  workspacePath: string;
  /**
   * workspace 身份键，与仓库统一约定一致：`workspaceIdentity?.trim() || workspacePath`。
   * M1 的 Bot workspace 是本机专用目录，没有独立 identity，因此等于 workspacePath；
   * 将来若出现远程 Bot workspace，这里换成 remote identity 即可，调用方无需改语义。
   */
  workspaceKey: string;
  /** 指向 Bot 对话 session 的指针；null = 还没开始过对话。 */
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BotWorkspaceRef {
  path: string;
  key: string;
}

export interface CreateBotConversationShellInput {
  workspace: BotWorkspaceRef;
  now: number;
}

export function createBotConversationShell(
  input: CreateBotConversationShellInput,
): BotConversationShell {
  return {
    workspacePath: input.workspace.path,
    workspaceKey: input.workspace.key,
    sessionId: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export interface ShellMutationResult {
  shell: BotConversationShell;
  /** 值未变化时为 false——调用方据此跳过写入，保证重复设置幂等。 */
  changed: boolean;
}

/**
 * 设置/清除对话指针。相同值重复设置不改 updatedAt、不触发写入。
 */
export function withBotConversationSession(
  shell: BotConversationShell,
  sessionId: string | null,
  now: number,
): ShellMutationResult {
  if (shell.sessionId === sessionId) return { shell, changed: false };
  return { shell: { ...shell, sessionId, updatedAt: now }, changed: true };
}

/**
 * 校正 workspace 归属：workspace 是宿主配置事实，读取持久化外壳时以当前配置为准，
 * 避免数据目录迁移或 profile 切换后指针仍指向旧 workspace。
 */
export function alignBotConversationWorkspace(
  shell: BotConversationShell,
  workspace: BotWorkspaceRef,
  now: number,
): ShellMutationResult {
  if (shell.workspacePath === workspace.path && shell.workspaceKey === workspace.key) {
    return { shell, changed: false };
  }
  return {
    shell: {
      ...shell,
      workspacePath: workspace.path,
      workspaceKey: workspace.key,
      updatedAt: now,
    },
    changed: true,
  };
}
