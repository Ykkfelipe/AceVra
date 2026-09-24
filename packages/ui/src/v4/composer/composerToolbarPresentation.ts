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
