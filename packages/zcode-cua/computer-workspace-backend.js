// AgentWorkspaceBackend — M2A of the background-first Computer Workspace spec
// (specs/computer-workspace.md). The first real workspace substrate behind the M1
// ComputerBackend seam.
//
// Substrate (proven in this milestone, driven through the SAME signed Helper and broker
// socket as every other Computer method — no new TCC principal, no new credential surface):
//   - pid-targeted background clicks: AX element resolution inside the target app's window
//     (role+label or coordinate), AXPress. The OS pointer is never moved, the app is never
//     activated, and no exclusive lease exists on this path.
//   - pid-targeted background typing: AX focus + CGEventPostToPid keyboard events. No event
//     tap, no frontmost requirement.
//   - capture: the existing observe rung already captures background/occluded windows
//     (Screen Recording belongs to the Helper); frames are tagged to this backend id.
//
// Honesty rules: capabilities below state only what THIS substrate actually does. The M2B
// virtual display may later upgrade ownsForegroundWorkspace — it is false here because M2A
// does not create one. The agent cursor is LOGICAL (backend-owned state): macOS has a single
// physical cursor and this backend never touches it.
//
// Zero-steal evidence: every workspace action envelope carries frontmost/cursor
// before/after from the Helper; the backend also keeps its own pre/post record when
// constructed with a `snapshot` probe so the acceptance harness can prove the invariant
// end-to-end (user foreground unchanged, physical cursor unchanged).

import { normalizeBackendCapabilities, routeClassFor } from "./computer-backend.js";
import { createWorkspaceProjection } from "./computer-workspace-projection.js";

const WORKSPACE_METHODS = Object.freeze(["workspace_click", "workspace_type_text"]);

/**
 * Build the agent workspace backend.
 *
 * @param options.execute the sanctioned runtime seam (same shape as the native backend).
 * @param options.snapshot optional zero-steal probe returning {frontmost, cursor} — wired
 *   by the host from a trusted source; never taken from model input.
 * @param options.projection optional workspace projection (M2B); when absent one is created
 *   for this backend instance so the mini Computer view always has a stable read model.
 */
export function createAgentWorkspaceBackend({ execute, snapshot, projection } = {}) {
  if (typeof execute !== "function") {
    throw new Error("createAgentWorkspaceBackend requires the runtime execute seam");
  }
  const capabilities = normalizeBackendCapabilities({
    id: "agent-workspace",
    observes: true,
    backgroundSemanticMutation: true,
    independentPointer: true,
    independentTextInput: true,
    ownsForegroundWorkspace: false,
    requiresUserForegroundForPhysicalInput: false,
    frameStream: true,
  });
  // Backend-owned logical agent cursor: where the agent last acted / will act inside its
  // targets. Never the user's physical cursor. Later rendered by the mini Computer view.
  let agentPointer = { x: null, y: null, target: null, updatedAt: null };
  const workspaceProjection =
    projection ??
    createWorkspaceProjection({ workspaceId: `workspace:${capabilities.id}` });

  const readSnapshot = async () => {
    if (typeof snapshot !== "function") return null;
    try {
      const record = await snapshot();
      return record && typeof record === "object"
        ? { frontmost: record.frontmost ?? null, cursor: record.cursor ?? null }
        : null;
    } catch {
      return null;
    }
  };

  return {
    capabilities,
    get agentPointer() {
      return { ...agentPointer };
    },
    /** M2B read model for the mini Computer view. Pure snapshot; never captures. */
    projectionSnapshot() {
      return workspaceProjection.snapshot();
    },
    async perform(method, args, context) {
      const route = routeClassFor(method, capabilities);
      const actionTarget = projectionTargetOf(args);
      workspaceProjection.noteActionStart({ method, target: actionTarget });
      const before = await readSnapshot();
      const result = await execute({
        toolName: `computer.${method}`,
        arguments: args,
        context,
      });
      const after = await readSnapshot();
      // Track the logical agent pointer from what the action actually addressed: an
      // explicit point when given, otherwise the element center the Helper resolved.
      let pointerUpdate = null;
      if (method === "workspace_click") {
        const point =
          args && typeof args.point === "object" && args.point !== null
            ? { x: args.point.x ?? null, y: args.point.y ?? null }
            : elementCenterOf(result);
        const now = Date.now();
        agentPointer = {
          x: point.x,
          y: point.y,
          target: targetOf(args, result),
          updatedAt: now,
        };
        pointerUpdate = { x: point.x, y: point.y };
      }
      const body = envelopeBodyOf(result);
      if (method === "observe") {
        workspaceProjection.noteObservation({ target: actionTarget, result: body });
      } else {
        workspaceProjection.noteActionResult({
          method,
          target: actionTarget,
          result: body,
          cursor: pointerUpdate,
        });
      }
      return {
        route,
        result,
        ...(before || after
          ? {
              zeroSteal: {
                before,
                after,
                frontmostUnchanged:
                  before && after
                    ? before.frontmost === after.frontmost && before.frontmost !== null
                    : null,
                cursorUnchanged:
                  before && after && before.cursor && after.cursor
                    ? before.cursor.x === after.cursor.x && before.cursor.y === after.cursor.y
                    : null,
              },
            }
          : {}),
      };
    },
  };
}

function projectionTargetOf(args) {
  if (!args || typeof args !== "object") return null;
  const pid = args.pid;
  if (typeof pid !== "number") return null;
  return {
    pid,
    windowId: typeof args.window_id === "number" ? args.window_id : null,
    appName: typeof args.app_name === "string" ? args.app_name : null,
  };
}

function envelopeBodyOf(result) {
  if (!result || typeof result !== "object") return null;
  if (typeof result.structuredContent === "object" && result.structuredContent !== null) {
    return result.structuredContent;
  }
  return result;
}

function elementCenterOf(result) {
  const body = envelopeBodyOf(result);
  const center = body && typeof body.element_center === "object" ? body.element_center : null;
  if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) {
    return { x: null, y: null };
  }
  return { x: center.x, y: center.y };
}

function targetOf(args, result) {
  const body = envelopeBodyOf(result);
  const target = body && typeof body.target === "object" ? body.target : null;
  return {
    pid: (args && args.pid) ?? (target ? target.pid : null) ?? null,
    role: target ? target.role ?? null : null,
    strategy: target ? target.strategy ?? null : null,
  };
}

export { WORKSPACE_METHODS };
