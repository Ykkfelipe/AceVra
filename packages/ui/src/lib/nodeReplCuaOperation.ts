// js cell 的 canonical Computer Use 操作识别（ActivityEventNormalizer 的分类边界）。
//
// 优先级：宿主记录的 `node_repl_images.cuaOperation`（bridge 实际执行的方法，模型不可写）
// > 结构化结果里的 `operation` 字段（该字段出现之前持久化的历史行回退）。两者都没有时
// 不是 Computer Use cell，渲染层不会给它 Computer 标签。
import { computerActionMethodFromOperation } from "@/lib/computerActionLabel.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

const HOST_CUA_OPERATION_PATTERN = /^[a-z0-9_.]{1,64}$/iu;

/**
 * 宿主记录的 Computer Use 操作（canonical operation identity）。
 *
 * 由 node_repl CUA bridge 在执行调用时记录、host-only `_meta` 传出、core 投影到
 * `node_repl_images.cuaOperation`；模型代码无法伪造。命中即说明这是一次 Computer Use cell，
 * 即便操作名不在标签表里（此时显示通用「正在使用电脑」，而不是模型标题）。
 */
function findHostCuaOperation(value: unknown, visited = new Set<object>()): string | undefined {
  if (!value || typeof value !== "object" || visited.has(value)) return undefined;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findHostCuaOperation(item, visited);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.kind === "node_repl_images") {
    const operation = readNonEmptyString(value.cuaOperation)?.trim();
    if (operation && HOST_CUA_OPERATION_PATTERN.test(operation)) {
      return computerActionMethodFromOperation(operation) ?? operation.toLowerCase();
    }
  }
  for (const item of Object.values(value)) {
    const found = findHostCuaOperation(item, visited);
    if (found) return found;
  }
  return undefined;
}

/** 结果投影有时把结构化结果压成 JSON 文本；只对短的对象文本做一次解析尝试。 */
const MAX_OPERATION_JSON_LENGTH = 20_000;

/**
 * 从 cell 的结构化结果里找出 Computer Use 操作名。
 *
 * 与 `findCuaApp` 同款递归：实时 tool.updated 把结果放在 raw.result 内，终态 snapshot
 * 则把 completed part 的 metadata 直接当作 raw，只扫一个固定位置会在对话结束后丢标签。
 * 只有落在 `computerActionLabel` 已知表里的名字才算命中——自定义 js cell 仍按普通 cell
 * 展示它的模型标题。
 */
function findComputerOperation(value: unknown, visited = new Set<object>()): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") || trimmed.length > MAX_OPERATION_JSON_LENGTH) {
      return undefined;
    }
    try {
      return findComputerOperation(JSON.parse(trimmed) as unknown, visited);
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || visited.has(value)) return undefined;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findComputerOperation(item, visited);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const operation = readNonEmptyString(value.operation);
  if (operation) {
    const method = computerActionMethodFromOperation(operation);
    if (method) return method;
  }
  for (const item of Object.values(value)) {
    const found = findComputerOperation(item, visited);
    if (found) return found;
  }
  return undefined;
}

/** The cell's Computer Use operation (normalized method), or undefined for a non-Computer cell. */
export function findNodeReplComputerOperation(sources: {
  display: unknown[];
  results: unknown[];
}): string | undefined {
  return findHostCuaOperation(sources.display) ?? findComputerOperation(sources.results);
}
