/**
 * Composer 动作区的共享展示契约。
 *
 * 这些常量只解决「外观与可达性一致」，不承载状态：picker 开关、backend/mode/CUA 的
 * 真值仍由各自现有 owner 拥有。集中在这里是为了避免 Backend、Mode、CUA 三个控件
 * 各自演化出不同的 focus ring、hit target 和边框语言。
 */

/**
 * 动作控件共享外观：高度固定 28px；宽度随内容增长，min-w-7 只兜住 icon-only 态。
 * 不能用 size-7：有文字标签时会把按钮锁成方块，造成相邻控件重叠。
 */
export const COMPOSER_TOOLBAR_TRIGGER_CLASS = [
  "h-7",
  "min-w-7",
  "max-w-full",
  "rounded-lg",
  "border-border",
  "bg-surface",
  "text-ui-base",
  "hover:bg-surface-hover",
  "focus-visible:outline-none",
  "focus-visible:ring-2",
  "focus-visible:ring-input-border-focused",
  "aria-expanded:border-input-border-focused",
  "aria-expanded:bg-input-focused",
].join(" ");

/** 动作簇布局：紧凑、可收缩，语义 role/label 由调用方补充。 */
export const COMPOSER_TOOLBAR_GROUP_CLASS = "flex min-w-0 items-center gap-1";

/**
 * Codex 模型控件的形态裁决（纯函数，便于确定性测试）。
 *
 * Codex 0.155.0-alpha.16.4 的 turn/start 接受 per-turn `model` + `effort`
 * 覆盖（schema 原文：“Override … for this turn and subsequent turns”），所以
 * 既有 Codex 会话同样可以切换模型/effort —— 两种场景都渲染可交互下拉：
 * - draft + codex / 既有 Codex 会话 = dropdown
 * - 其余（Agent 后端 / 非本后端）= null，由 Agent 的模型选择器接管。
 */
export function resolveCodexModelControlKind(params: {
  draftMode: boolean;
  codexSession: boolean;
  backend: "zcode" | "codex";
}): "dropdown" | null {
  if (params.draftMode) return params.backend === "codex" ? "dropdown" : null;
  return params.codexSession ? "dropdown" : null;
}

/**
 * Provider 菜单的可见性裁决（纯函数，便于确定性测试）。
 *
 * 已有 zcode family 会话（Z.ai/Azure/Command Code 等）复用草稿态同一条模型选择写路径
 * 切换 provider——和 Models 下拉换模型本来就走同一个 handler，不需要区分草稿态。
 * 已有 Codex 会话默认让位给下方 Codex 专属模型/effort 控件；但 Host 装了迁移服务后，
 * 该菜单是迁回 Agent 的唯一入口，必须保留。
 */
export function shouldShowComposerProviderMenu(params: {
  draftMode: boolean;
  codexSession: boolean;
  /** 正式会话具备跨后端迁移能力（Host 注册了 backendMigrationService）。 */
  backendMigrationAvailable?: boolean;
}): boolean {
  return params.draftMode || !params.codexSession || params.backendMigrationAvailable === true;
}
