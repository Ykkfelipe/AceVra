// Semantic action geometry for the local preview's logical cursor (computer-workspace.md).

const SEMANTIC_GEOMETRY_LIMIT = 4000;

/**
 * 语义动作（press / set_value）只带 semantic_ref，没有坐标与 pid。修复依据（f4fdd904 实测
 * 逻辑光标从未出现）：agent 全程用语义动作，光标只由 workspace_* 产生。semantic_ref 由同一
 * 会话最近一次 observe 的树铸造，树里带每个元素的全局 AX frame 与 pid；这里记住
 * ref → {pid, 中心点}，供语义动作完成时上报目标与逻辑光标。每次 observe 同一 pid 时整体替换，
 * 过期 ref 不会把光标画到别处（Helper 也会以 stale_target 拒绝过期 ref）。
 */
export function rememberSemanticGeometry(store, sessionId, result) {
  const pid = Number.isInteger(result?.pid) ? result.pid : undefined;
  const elements = Array.isArray(result?.tree?.elements) ? result.tree.elements : null;
  if (!sessionId || pid === undefined || !elements) return;
  const geometry = new Map();
  for (const element of elements) {
    const frame = element?.frame;
    if (typeof element?.semantic_ref !== "string" || !frame) continue;
    if (![frame.x, frame.y, frame.w, frame.h].every(Number.isFinite)) continue;
    geometry.set(element.semantic_ref, { pid, x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 });
    if (geometry.size >= SEMANTIC_GEOMETRY_LIMIT) break;
  }
  store.set(sessionId, geometry);
}

/**
 * M3 workspace cursor report: where the click addressed, in the target window's own
 * coordinate space — the explicit point when the model gave one, otherwise the element
 * center the Helper resolved. Display-only facts for the mini Computer view; never the
 * physical macOS cursor.
 */
export function workspaceCursorOf(args, result) {
  const point = args && typeof args.point === "object" && args.point !== null ? args.point : null;
  if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
    return { x: point.x, y: point.y };
  }
  // broker 回包是扁平 envelope：element_center 直接在顶层（structuredContent 是模型面包装后的形态）。
  const body = result && typeof result === "object" ? result : null;
  const nested =
    body && typeof body.structuredContent === "object" && body.structuredContent !== null
      ? body.structuredContent
      : null;
  const center =
    (body && typeof body.element_center === "object" ? body.element_center : null) ??
    (nested && typeof nested.element_center === "object" ? nested.element_center : null);
  if (center && Number.isFinite(center.x) && Number.isFinite(center.y)) {
    return { x: center.x, y: center.y };
  }
  return undefined;
}

/** The observed {pid, centre} a semantic press/set_value addressed, or undefined if unknown. */
export function semanticTargetOf(store, sessionId, method, args) {
  if (method !== "press" && method !== "set_value") return undefined;
  if (typeof args?.semantic_ref !== "string") return undefined;
  return store.get(sessionId)?.get(args.semantic_ref);
}
