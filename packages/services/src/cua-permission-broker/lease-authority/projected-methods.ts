// 从 authority.ts 抽出的方法分类常量（架构红线：契约文件行数上限）。
//
// M3：宿主侧维护的 mini Computer 投影只跟踪 workspace 面向的方法（observe 建立帧，
// workspace_* 是后台动作）。原生前台动作仍由既有 bar 投影表达，不混入 workspace 视图。
// press / set_value 是后台语义动作：运行时从最近一次 observe 的树解析出目标 pid 与元素中心，
// 与 workspace_* 一样驱动本地预览的目标窗口与逻辑光标（不再只有 workspace_* 才有光标）。
export const WORKSPACE_PROJECTED_METHOD_NAMES = [
  "observe",
  "workspace_click",
  "workspace_type_text",
  "workspace_scroll",
  "press",
  "set_value",
] as const;
