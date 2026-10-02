// Protected foreground execution under a runtime-owned grant (specs/computer-use.md
// "Protected foreground grant", "Helper restart / reacquire", "Generation fencing").
//
// Split from index.js: index.js keeps admission, activity reporting and the model boundary; this
// module owns the private grant bindings and the model-facing protected decisions. Native-lease
// mechanics live in protected-native-lease.js; the ownership model and event order are in
// protected-foreground.js.

import { requireTakeoverGrant } from "./takeover-grant.js";
import {
  foregroundObservationGeometry,
  hasForegroundObservation,
} from "./foreground-observations.js";
import {
  createProtectedGrantBindings,
  foregroundRecord,
  fromBoundGeneration,
  grantRefusal,
  isNativeLeaseEndedCode,
  isUserReclaimCode,
  protectedForegroundView,
  runtimeForegroundRefusal,
  sameForegroundGeometry,
  statusRecord,
  withoutNativeLease,
} from "./protected-foreground.js";
import { coded, createNativeLeaseOps } from "./protected-native-lease.js";
import { classifyThrownFailure, failureHint } from "./transport-errors.js";

/**
 * @param {object} deps
 * @param {(method: string, params: object, timeoutMs?: number) => Promise<any>} deps.helperCall
 * @param {object | undefined} deps.leaseAuthority
 * @param {Map} deps.foregroundObservations  the runtime's foreground observation ledger
 * @param {() => number} [deps.now]
 */
export function createProtectedForegroundController(deps) {
  const { helperCall, leaseAuthority, foregroundObservations } = deps;
  const now = deps.now ?? Date.now;
  const bindings = createProtectedGrantBindings();
  const { ownerParams, grantView, dropNative, endBinding, acquireNative, reacquire } =
    createNativeLeaseOps({
      helperCall,
      leaseAuthority,
      foregroundObservations,
      bindings,
    });

  async function acquire({ sessionId, task, observationId }) {
    if (!leaseAuthority || !sessionId) {
      throw coded("foreground lease authority is unavailable", "lease_authority_unavailable");
    }
    const existing = bindings.get(sessionId);
    if (existing && existing.taskId === task) {
      const refusal = grantRefusal(existing, await grantView(sessionId, task));
      if (!refusal) {
        // 同一任务已在授权下：模型不必（也不能）持有原生租约；原生租约缺失时下一次动作重新获取。
        return foregroundRecord("acquire_control", existing.native ? "active" : "reacquiring", {
          evidence: [{ kind: "protected_grant", state: "active", reused: true }],
          ...protectedForegroundView(existing),
        });
      }
      await endBinding(sessionId, refusal);
    } else if (existing) {
      await endBinding(sessionId, "task_changed");
    }
    if (!hasForegroundObservation(foregroundObservations, sessionId, observationId)) {
      throw coded(
        "this observation carries no foreground geometry, so the Helper cannot grant a lease. Call list_windows, then get_app_state with that window's window_id (foreground_geometry is only issued for an explicit window), and pass its foreground_geometry.observation_id straight to computer.acquire_control. The user was not asked for approval.",
        "foreground_geometry_unavailable",
      );
    }
    await requireTakeoverGrant(leaseAuthority, { session: sessionId, task });
    const acquired = await acquireNative(sessionId, task, observationId);
    if (!acquired.native) return acquired.result;
    const view = await grantView(sessionId, task);
    const binding = {
      grantId: view?.grantId,
      taskId: task,
      computerSessionId: sessionId,
      approvedAt: now(),
      expiresAt: view?.expiresAt,
      target: foregroundObservationGeometry(foregroundObservations, sessionId, observationId) ?? {},
      native: acquired.native,
    };
    bindings.set(sessionId, binding);
    return withoutNativeLease(acquired.result, binding);
  }

  /** computer.release_control: the model gives control back (the grant stays for this task). */
  async function release({ sessionId }) {
    const binding = bindings.get(sessionId);
    if (!binding) {
      return foregroundRecord("release_control", "released", {
        evidence: [{ kind: "protected_grant", state: "inactive" }],
        ...protectedForegroundView(undefined),
      });
    }
    bindings.delete(sessionId);
    const native = binding.native;
    let result;
    if (native) {
      try {
        result = await helperCall("release_control", {
          lease_id: native.helperLeaseId,
          ...ownerParams(sessionId, binding.taskId),
        });
      } catch {
        result = undefined;
      }
      binding.native = null;
      if (typeof leaseAuthority?.release === "function") {
        await leaseAuthority
          .release(native.authorityLeaseId, "model_release")
          .catch(() => undefined);
      }
    }
    return withoutNativeLease(
      result ??
        foregroundRecord("release_control", "released", {
          evidence: [{ kind: "exclusive_lease", state: "released" }],
        }),
      undefined,
    );
  }

  /** computer.control_status: the grant state for this task (no lease id needed or shown). */
  async function status({ sessionId, task }) {
    const binding = bindings.get(sessionId);
    if (!binding || binding.taskId !== task) return statusRecord(undefined, "inactive");
    const refusal = grantRefusal(binding, await grantView(sessionId, task));
    if (refusal) {
      await endBinding(sessionId, refusal);
      return { ...statusRecord(undefined, "inactive"), code: refusal };
    }
    let leaseState = binding.native ? "active" : "reacquiring";
    if (binding.native) {
      try {
        const native = await helperCall("control_status", {
          lease_id: binding.native.helperLeaseId,
        });
        if (!fromBoundGeneration(binding, native) || native?.lease_state !== "active") {
          await dropNative(binding, "connection_generation_changed");
          leaseState = "reacquiring";
        }
      } catch {
        leaseState = "reacquiring";
      }
    }
    return statusRecord(binding, leaseState);
  }

  function substituteObservation(sessionId, args, reacquired) {
    const modelGeometry = foregroundObservationGeometry(
      foregroundObservations,
      sessionId,
      args?.observation_id,
    );
    return sameForegroundGeometry(modelGeometry, reacquired.geometry)
      ? reacquired.observationId
      : null;
  }

  const notDeliveredAfterReacquire = (binding) =>
    runtimeForegroundRefusal("connection_generation_changed", {
      recoverable: true,
      delivery: "not_sent",
      recovered: true,
      message:
        "Screen control was re-established under your existing approval after the Helper restarted, but the window changed since your observation, so this action was NOT sent. Call get_app_state and repeat it.",
      ...protectedForegroundView(binding),
    });

  /**
   * A protected action (click, key_press, …). The runtime resolves task → grant → generation →
   * native lease; the model passes only the action and its observation.
   */
  async function act({ sessionId, task, method, args }) {
    const binding = bindings.get(sessionId);
    if (!binding || binding.taskId !== task) {
      return runtimeForegroundRefusal("invalid_lease", {
        message:
          "No screen takeover is active for this task. Call computer.acquire_control first (the user approves it in AceVra).",
        ...protectedForegroundView(undefined),
      });
    }
    const refusal = grantRefusal(binding, await grantView(sessionId, task));
    if (refusal) {
      await endBinding(sessionId, refusal);
      return runtimeForegroundRefusal(refusal, {
        message: failureHint(refusal),
        ...protectedForegroundView(undefined),
      });
    }
    // 模型附带的 lease_id 一律忽略：原生租约只由本绑定注入（旧调用兼容）。
    const actionArgs = { ...args };
    delete actionArgs.lease_id;
    // 新租约获取后决定能否发送：窗口未变才换用新观察，否则如实返回"未送达"。
    const resumeAfter = async (recover, extra = {}) => {
      const reacquired = await reacquire(sessionId, binding, { recover });
      binding.needsRecovery = !reacquired.ok && reacquired.code === "helper_disconnected";
      if (!reacquired.ok) {
        return {
          response: runtimeForegroundRefusal(reacquired.code, {
            ...extra,
            message: failureHint(reacquired.code),
            ...protectedForegroundView(bindings.get(sessionId)),
          }),
        };
      }
      const next = substituteObservation(sessionId, actionArgs, reacquired);
      return next ? { observationId: next } : { response: notDeliveredAfterReacquire(binding) };
    };
    let observationId = actionArgs.observation_id;
    if (!binding.native) {
      const resumed = await resumeAfter(binding.needsRecovery === true);
      if (resumed.response) return resumed.response;
      observationId = resumed.observationId;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const native = binding.native;
      let result;
      try {
        result = await helperCall(method, {
          ...actionArgs,
          observation_id: observationId,
          lease_id: native.helperLeaseId,
          ...ownerParams(sessionId, task),
        });
      } catch (error) {
        const failure = classifyThrownFailure(error);
        binding.native = null;
        await dropNative({ ...binding, native }, failure.code);
        if (failure.delivery === "not_sent" && attempt === 0) {
          // 确定未送达：经生命周期所有者恢复 Helper、在同一授权下获取新租约，窗口未变则重试一次。
          const resumed = await resumeAfter(true, { delivery: "not_sent" });
          if (resumed.response) return resumed.response;
          observationId = resumed.observationId;
          continue;
        }
        // 投递状态不明：恢复并重新获取租约，但绝不静默重放；如实返回 effect_unverified。
        const reacquired = await reacquire(sessionId, binding, {
          recover: true,
        });
        binding.needsRecovery = !reacquired.ok && reacquired.code === "helper_disconnected";
        return runtimeForegroundRefusal("effect_unverified", {
          operation: method,
          effect: "unknown",
          input_delivery: "unknown",
          delivery: "unknown",
          original_code: failure.original_code,
          recovered: reacquired.ok,
          message: failureHint("effect_unverified"),
          ...protectedForegroundView(bindings.get(sessionId)),
        });
      }
      if (!fromBoundGeneration({ native }, result)) {
        // 代际栅栏：别的代际产生的应答绝不更新本绑定。新代际的 Helper 不可能持有旧租约，
        // 它的回答只能是拒绝（未执行），按 not_sent 处理。
        binding.native = null;
        await dropNative({ ...binding, native }, "connection_generation_changed");
        if (attempt === 0) {
          const resumed = await resumeAfter(false);
          if (resumed.response) return resumed.response;
          observationId = resumed.observationId;
          continue;
        }
        return runtimeForegroundRefusal("connection_generation_changed", {
          message: failureHint("connection_generation_changed"),
          ...protectedForegroundView(binding),
        });
      }
      if (result?.effect === "refused" && isUserReclaimCode(result.code)) {
        // 用户夺回控制：authority 以该原因结束租约并撤销授权；运行时绑定同步结束。
        bindings.delete(sessionId);
        binding.native = null;
        if (typeof leaseAuthority?.release === "function") {
          await leaseAuthority.release(native.authorityLeaseId, result.code).catch(() => undefined);
        }
        return withoutNativeLease(result, undefined);
      }
      if (result?.effect === "refused" && isNativeLeaseEndedCode(result.code) && attempt === 0) {
        // 原生租约结束（15 s 期限、重连栅栏、宿主断开）但授权仍有效：检查在投递之前，
        // 确定未送达；重新获取新租约，窗口未变则重试一次。
        await dropNative(binding, result.code);
        const resumed = await resumeAfter(false, {
          original_code: result.code,
        });
        if (resumed.response) return resumed.response;
        observationId = resumed.observationId;
        continue;
      }
      if (result?.lease_state === "inactive" || result?.lease_state === "interrupted") {
        // Helper 因焦点变化/陈旧几何等结束了原生租约：授权保留，下一次动作在同一授权下重新获取。
        await dropNative(
          binding,
          typeof result.code === "string" ? result.code : "helper_ended_lease",
        );
      }
      return withoutNativeLease(result, binding);
    }
    return notDeliveredAfterReacquire(binding);
  }

  return {
    acquire,
    act,
    release,
    status,
    endBinding,
    /** Read-only, for tests and diagnostics; never exposes native lease ids to the model. */
    describe: (sessionId) => protectedForegroundView(bindings.get(sessionId)),
    async closeSession(sessionId) {
      await endBinding(sessionId, "session_closed");
    },
    async dispose() {
      for (const sessionId of bindings.sessions()) await endBinding(sessionId, "runtime_cleanup");
    },
  };
}
