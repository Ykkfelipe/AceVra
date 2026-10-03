interface PaneReadOnlyComposerNoticeInput<T> {
  /** pane 当前展示的 workspace 是否就是 shell 的活动 workspace。 */
  isShellWorkspace: boolean;
  /** shell workspace 是否只读（目前仅由本地目录不可用导致）。 */
  shellReadOnly: boolean;
  /** pane 自身绑定是否只读（subagent 观察视图等）。 */
  bindingReadOnly: boolean;
  notice: T | undefined;
}

/**
 * composer 位置说明只解释 shell workspace 的只读原因。
 * pane 自身绑定的只读（观察视图）或其他 workspace 的 pane 不显示，避免误导。
 */
export function resolvePaneReadOnlyComposerNotice<T>({
  isShellWorkspace,
  shellReadOnly,
  bindingReadOnly,
  notice,
}: PaneReadOnlyComposerNoticeInput<T>): T | undefined {
  return isShellWorkspace && shellReadOnly && !bindingReadOnly ? notice : undefined;
}
