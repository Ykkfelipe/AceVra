import type { NodeReplCuaApp, NodeReplDisplayImage } from "@/lib/nodeReplToolDisplay.js";

const IMAGE_MIME_TYPE_PATTERN = /^image\/[a-z0-9.+-]+$/iu;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim().length > 0 ? value : undefined;
}

export function extractImages(values: unknown[]): NodeReplDisplayImage[] {
  const images: NodeReplDisplayImage[] = [];
  const seen = new Set<string>();
  const visited = new Set<object>();
  const addImage = (value: Record<string, unknown>) => {
    // 旧 built-in result 使用 {images:[{base64,mimeType}]}，真实 MCP
    // 使用 content 里的 {type:"image",data,mimeType}。专用 renderer 必须兼容两种历史形态。
    const base64 = readNonEmptyString(value.base64) ?? readNonEmptyString(value.data);
    const mimeType = readNonEmptyString(value.mimeType)?.trim();
    if (!base64 || !mimeType || !IMAGE_MIME_TYPE_PATTERN.test(mimeType)) {
      return;
    }
    const key = `${mimeType}:${base64.length}:${base64.slice(0, 24)}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    images.push({ base64, mimeType });
  };
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    if (value.type === "image" || "base64" in value) addImage(value);
    for (const [key, child] of Object.entries(value)) {
      // 观察类截图（CUA-1.6）走独立通道，绝不能混进聊天可见 images 的通用扫描。
      if (key === "observationImages") continue;
      visit(child);
    }
  };

  for (const value of values) {
    visit(value);
  }

  return images;
}

/**
 * 从 raw 里找 node_repl display 携带的 App 身份。
 *
 * 与 `extractImages` / `hasBrowserTurnEndDisplay` 同款递归：实时 tool.updated 把 display 放在
 * raw.result 内，终态 snapshot 则把 completed part 的 metadata 直接当作 raw，只扫一个固定位置
 * 会让对话结束后图标消失。
 */
export function findCuaApp(
  value: unknown,
  visited = new Set<object>(),
): NodeReplCuaApp | undefined {
  if (!value || typeof value !== "object" || visited.has(value)) return undefined;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCuaApp(item, visited);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.kind === "node_repl_images" && isRecord(value.app)) {
    const appKey = readNonEmptyString(value.app.appKey)?.trim();
    if (appKey) {
      const displayName = readNonEmptyString(value.app.displayName)?.trim();
      return { appKey, ...(displayName ? { displayName } : {}) };
    }
  }
  for (const item of Object.values(value)) {
    const found = findCuaApp(item, visited);
    if (found) return found;
  }
  return undefined;
}

export function hasBrowserTurnEndDisplay(value: unknown, visited = new Set<object>()): boolean {
  if (!value || typeof value !== "object" || visited.has(value)) return false;
  visited.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => hasBrowserTurnEndDisplay(item, visited));
  }
  if (!isRecord(value)) return false;
  if (value.kind === "node_repl_images" && value.source === "browser_turn_end") return true;
  return Object.values(value).some((item) => hasBrowserTurnEndDisplay(item, visited));
}

/**
 * 从 raw 里找 display 携带的观察类截图（agent 自用；CUA-1.6）。
 *
 * 与 findCuaApp 同款递归：实时 tool.updated 与终态 snapshot 的 display 位置不同，只扫固定
 * 位置会让折叠区缩略图在对话结束后消失。extractImages 已跳过 observationImages 键，
 * 这里是它们进入 UI 模型的唯一通道。
 */
export function findObservationImages(
  value: unknown,
  visited = new Set<object>(),
): NodeReplDisplayImage[] {
  const found: NodeReplDisplayImage[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object" || visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isRecord(node)) return;
    if (node.kind === "node_repl_images" && Array.isArray(node.observationImages)) {
      for (const image of node.observationImages) {
        if (!isRecord(image)) continue;
        const base64 = readNonEmptyString(image.base64);
        const mimeType = readNonEmptyString(image.mimeType)?.trim();
        if (base64 && mimeType && IMAGE_MIME_TYPE_PATTERN.test(mimeType)) {
          found.push({ base64, mimeType });
        }
      }
      return;
    }
    for (const item of Object.values(node)) walk(item);
  };
  walk(value);
  return found;
}

export function hasComputerImageDisplay(value: unknown, visited = new Set<object>()): boolean {
  if (!value || typeof value !== "object" || visited.has(value)) return false;
  visited.add(value);
  if (Array.isArray(value)) return value.some((item) => hasComputerImageDisplay(item, visited));
  if (!isRecord(value)) return false;
  if (
    value.kind === "node_repl_images" &&
    value.cuaOperation &&
    value.source !== "browser_turn_end" &&
    Array.isArray(value.images) &&
    value.images.length > 0
  ) {
    return true;
  }
  return Object.values(value).some((item) => hasComputerImageDisplay(item, visited));
}
