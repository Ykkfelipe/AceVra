import type { ComputerAction, ComputerImage } from "@zcode/shared";
import { createServiceLogger } from "@zcode/services/node";
import { PAUSED_REASONS } from "./computerJob.js";
import type { WorkerClient, WorkerResponse } from "./workerClient.js";

const log = createServiceLogger("computers");

/**
 * screenshot：worker 侧已按 spec 4.5.1 收敛后才返回画面；这里只编码并记录
 * action→fresh-frame 延迟测量值（settle 头不进 agent 载荷）。
 */
export async function captureConvergedScreenshot(
  client: WorkerClient | null,
  encode: (png: Buffer) => ComputerImage | null,
): Promise<WorkerResponse | { ok: true; image: ComputerImage | null }> {
  const shot = client ? await client.screenPng() : null;
  if (!shot)
    return { ok: false, status: 0, code: "offline", reason: "screen_unavailable", json: null };
  log.debug(
    `screen settle=${shot.settleMs ?? "?"}ms converged=${shot.converged ?? "?"} ${shot.png.length}B`,
  );
  if (shot.converged === false) log.warn("screen did not converge within the worker settle window");
  return { ok: true, image: encode(shot.png) };
}

export type ComputerActionOutcome =
  | {
      ok: true;
      screen: { width: number; height: number };
      image?: ComputerImage;
      /** First action of this conversation on this computer (renderer opens the tab once). */
      sessionStarted?: boolean;
    }
  | {
      ok: false;
      reason:
        | "target_not_found"
        | "computer_offline"
        | "computer_busy"
        | "computer_paused"
        | "internal";
      detail?: string;
    };

/** Worker refusal → agent-facing reason. 409 means the worker paused the agent (user / input). */
export function classifyActionFailure(
  result: Extract<WorkerResponse, { ok: false }>,
): Extract<ComputerActionOutcome, { ok: false }> {
  if (result.code === "offline")
    return { ok: false, reason: "computer_offline", detail: result.reason ?? undefined };
  if (result.status === 409 || PAUSED_REASONS.has(result.reason ?? ""))
    return {
      ok: false,
      reason: "computer_paused",
      detail: result.reason ?? result.code ?? undefined,
    };
  return { ok: false, reason: "internal", detail: result.reason ?? `status_${result.status}` };
}

type Post = (path: string, body: Record<string, unknown>) => Promise<WorkerResponse>;

/** Maps one agent input action onto the worker's v1 routes (screenshots are handled by the caller). */
export async function runInputAction(
  action: Exclude<ComputerAction, { kind: "screenshot" }>,
  post: Post,
): Promise<WorkerResponse> {
  switch (action.kind) {
    case "click":
      return post(action.double ? "/doubleclick" : "/click", {
        x: action.x,
        y: action.y,
        button: action.button ?? "left",
      });
    case "move":
      return post("/move", { x: action.x, y: action.y });
    case "drag": {
      // worker 的 /drag 从当前位置拖到目标点，所以先移动到起点。
      const moved = await post("/move", { x: action.fromX, y: action.fromY });
      return moved.ok ? post("/drag", { x: action.toX, y: action.toY }) : moved;
    }
    case "scroll": {
      if (action.x !== undefined && action.y !== undefined) {
        const moved = await post("/move", { x: action.x, y: action.y });
        if (!moved.ok) return moved;
      }
      // pyautogui.scroll 在 Windows 上是原始 wheel delta（120 = 一格）；dy > 0 表示向下滚动。
      return post("/scroll", { amount: -action.dy * 120 });
    }
    case "type":
      return post("/type", { text: action.text });
    case "key":
      return action.keys.length === 1
        ? post("/key", { key: action.keys[0] })
        : post("/hotkey", { keys: action.keys });
  }
}
