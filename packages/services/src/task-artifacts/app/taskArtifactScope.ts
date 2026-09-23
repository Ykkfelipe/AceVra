// task artifact 的任务作用域解析（纯函数，无 IO）。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** ZCode runtime 会话 id 形如 `sess_<uuid>`；前缀大小写敏感，与运行时生成一致。 */
const RUNTIME_SESSION_PREFIX = "sess_";

export function isUuidLike(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * task 作用域的唯一解析入口（register/list/read/meta/锁全部经此）。
 *
 * 修复依据：注册表曾只接受裸 UUID，而真实 ZCode 会话 id 是 `sess_<uuid>`，
 * 导致真实浏览器截图注册一律 artifact_invalid_scope。这里把两种形式归一到同一个
 * 小写 UUID；只有该规范 UUID 会成为文件系统路径分量，原始 id 从不直接拼路径。
 * 返回 null 表示不是合法任务 id（含 `sess_` 后非 UUID、穿越/路径形态）。
 */
export function resolveTaskArtifactScope(taskId: string): { canonicalTaskId: string } | null {
  const candidate = taskId.startsWith(RUNTIME_SESSION_PREFIX)
    ? taskId.slice(RUNTIME_SESSION_PREFIX.length)
    : taskId;
  return UUID_RE.test(candidate) ? { canonicalTaskId: candidate.toLowerCase() } : null;
}
