// Native-lease operations for the runtime ProtectedForegroundGrant, split from
// protected-runtime.js (single-file size boundary). Every function here acts on one binding:
// acquire a NEW native lease under a still-valid grant, drop a dead/fenced one, or end the
// binding. A native lease is never resurrected across Helper connection generations.

import {
  foregroundObservationGeometry,
  rememberForegroundObservations,
} from "./foreground-observations.js";
import { grantRefusal } from "./protected-foreground.js";
import { classifyThrownFailure } from "./transport-errors.js";

export function coded(message, code, details) {
  return Object.assign(new Error(message), {
    code,
    ...(details ? { details } : {}),
  });
}

/**
 * @param {object} deps
 * @param {(method: string, params: object, timeoutMs?: number) => Promise<any>} deps.helperCall
 * @param {object | undefined} deps.leaseAuthority
 * @param {Map} deps.foregroundObservations
 * @param {ReturnType<import("./protected-foreground.js").createProtectedGrantBindings>} deps.bindings
 */
export function createNativeLeaseOps({
  helperCall,
  leaseAuthority,
  foregroundObservations,
  bindings,
}) {
  const ownerParams = (sessionId, task) => ({
    owner_session: sessionId,
    owner_task: task,
  });

  async function grantView(sessionId, task) {
    if (!leaseAuthority || typeof leaseAuthority.takeoverStatus !== "function") return undefined;
    try {
      return await leaseAuthority.takeoverStatus({ session: sessionId, task });
    } catch {
      return undefined;
    }
  }

  /** Native lease is dead or fenced: release it in the authority. Lifecycle reasons keep the grant. */
  async function dropNative(binding, reason, { releaseHelper = false } = {}) {
    const native = binding?.native;
    if (!native) return;
    binding.native = null;
    if (releaseHelper) {
      await helperCall(
        "release_control",
        {
          lease_id: native.helperLeaseId,
          ...ownerParams(binding.computerSessionId, binding.taskId),
        },
        2000,
      ).catch(() => undefined);
    }
    if (leaseAuthority && typeof leaseAuthority.release === "function") {
      await leaseAuthority.release(native.authorityLeaseId, reason).catch(() => undefined);
    }
  }

  /** End the binding entirely (grant revoked/expired, task changed, session closed). */
  async function endBinding(sessionId, reason) {
    const binding = bindings.get(sessionId);
    if (!binding) return;
    bindings.delete(sessionId);
    await dropNative(binding, reason, { releaseHelper: true });
  }

  /** authority reservation → Helper acquire → commit (with the issuing connection generation). */
  async function acquireNative(sessionId, task, observationId) {
    const reservation = await leaseAuthority.beginAcquire({
      session: sessionId,
      task,
    });
    let result;
    const releaseIssued = async () => {
      if (typeof result?.lease_id !== "string") return;
      await helperCall(
        "release_control",
        { lease_id: result.lease_id, ...ownerParams(sessionId, task) },
        2000,
      ).catch(() => undefined);
    };
    try {
      result = await helperCall("acquire_control", {
        observation_id: observationId,
        ...ownerParams(sessionId, task),
      });
      if (result?.effect === "confirmed" && typeof result?.lease_id === "string") {
        const requirement = result?.helper_identity?.requirement;
        if (typeof requirement !== "string" || requirement.length === 0) {
          await releaseIssued();
          throw coded("verified Helper requirement is unavailable", "lease_authority_unavailable");
        }
        const committed = await leaseAuthority.commitAcquire(
          reservation.leaseId,
          result.lease_id,
          requirement,
          result.connection_generation,
        );
        return {
          result: {
            ...result,
            lease_authority_generation: committed?.generation,
          },
          native: {
            helperLeaseId: result.lease_id,
            authorityLeaseId: reservation.leaseId,
            ...(Number.isInteger(result.connection_generation)
              ? { connectionGeneration: result.connection_generation }
              : {}),
          },
        };
      }
      await leaseAuthority.stop().catch(() => undefined);
      await releaseIssued();
      return { result, native: null };
    } catch (error) {
      await leaseAuthority.stop().catch(() => undefined);
      await releaseIssued();
      throw error;
    }
  }

  /**
   * Re-establish a NEW native lease for a still-valid grant (Helper restart, reconnect fence,
   * native lease expiry). Never resurrects the old lease. Returns the fresh observation so the
   * caller can decide whether the model's pending action may be sent.
   */
  async function reacquire(sessionId, binding, { recover }) {
    await dropNative(binding, "connection_generation_changed");
    if (recover) {
      let recovered;
      try {
        recovered = await leaseAuthority?.recoverHelper?.();
      } catch {
        recovered = undefined;
      }
      if (!recovered?.connected) return { ok: false, code: "helper_disconnected" };
    }
    const before = grantRefusal(binding, await grantView(sessionId, binding.taskId));
    if (before) return { ok: false, code: before };
    const { pid, window_id: windowId } = binding.target ?? {};
    if (!Number.isInteger(pid) || !Number.isInteger(windowId)) {
      return { ok: false, code: "foreground_geometry_unavailable" };
    }
    let observed;
    try {
      observed = await helperCall("observe", { pid, window_id: windowId });
    } catch (error) {
      return { ok: false, code: classifyThrownFailure(error).code };
    }
    rememberForegroundObservations(foregroundObservations, sessionId, observed);
    const observationId = observed?.foreground_geometry?.observation_id;
    if (typeof observationId !== "string") {
      return { ok: false, code: "foreground_geometry_unavailable" };
    }
    let acquired;
    try {
      acquired = await acquireNative(sessionId, binding.taskId, observationId);
    } catch (error) {
      return { ok: false, code: classifyThrownFailure(error).code };
    }
    if (!acquired.native) {
      return { ok: false, code: acquired.result?.code ?? "exclusive_busy" };
    }
    binding.native = acquired.native;
    // Stop/Pause may have raced the acquisition: the grant is checked again AFTER commit, and a
    // lease acquired under a revoked grant is released at once (Stop always wins).
    const after = grantRefusal(binding, await grantView(sessionId, binding.taskId));
    if (after) {
      await endBinding(sessionId, after);
      return { ok: false, code: after };
    }
    return {
      ok: true,
      observationId,
      geometry: foregroundObservationGeometry(foregroundObservations, sessionId, observationId),
    };
  }

  /** computer.acquire_control: user Allow (once per task) → native lease → private binding. */

  return {
    ownerParams,
    grantView,
    dropNative,
    endBinding,
    acquireNative,
    reacquire,
  };
}
