// Screen takeover gate for computer.acquire_control (specs/computer-use.md "Screen takeover").
//
// The runtime may only *request* takeover and *read* the user's decision through the lease
// authority sideband; the owning UI is the only party that can allow it. This module asks once
// and then waits a bounded time for the decision, so a js cell (30 s default timeout) never
// hangs: an unanswered request stays answerable and a later Allow is used by the next call.

export const TAKEOVER_WAIT_MS = 25_000;
const TAKEOVER_POLL_MS = 500;

function refusal(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Resolves when the user allowed takeover for this (session, task); otherwise throws a coded
 * error (`takeover_declined`, `takeover_pending`, `takeover_unavailable`).
 */
export async function requireTakeoverGrant(leaseAuthority, owner, options = {}) {
  const waitMs = options.waitMs ?? TAKEOVER_WAIT_MS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  if (
    !leaseAuthority ||
    typeof leaseAuthority.requestTakeover !== "function" ||
    typeof leaseAuthority.takeoverStatus !== "function" ||
    !owner?.session ||
    !owner?.task
  ) {
    throw refusal(
      "takeover_unavailable",
      "screen takeover approval is not available in this session; keep working in the background",
    );
  }
  let state = (await leaseAuthority.requestTakeover(owner))?.state;
  // 已批准（同一任务早先 Allow）：观察仍是调用方刚取的，直接放行。
  if (state === "granted") return;
  const deadline = now() + waitMs;
  while (state === "pending" && now() < deadline) {
    await sleep(TAKEOVER_POLL_MS);
    state = (await leaseAuthority.takeoverStatus(owner))?.state;
  }
  if (state === "granted") {
    // 修复依据（installed d825c492 实测）：Helper 只接受 3 s 内的观察
    // （ForegroundControl.swift foregroundObservationAge）。等待用户点 Allow 必然超过它，
    // 带着旧 observation_id 进 Helper 只会得到 stale_geometry。授权已记录到本任务，
    // 让模型重新观察后立即再调一次 acquire_control（此时直接放行）。
    throw refusal(
      "takeover_allowed_reobserve",
      "the user allowed screen takeover for this task. Your observation is now too old: call get_app_state again and immediately call computer.acquire_control with the new observation_id (it will not ask again)",
    );
  }
  if (state === "denied") {
    throw refusal(
      "takeover_declined",
      "the user declined screen takeover. Do not ask again in this task; continue with background actions or tell the user which step needs their hands",
    );
  }
  throw refusal(
    "takeover_pending",
    "waiting for the user to allow screen takeover (an Allow/Deny card is shown in AceVra). Tell the user, then call computer.acquire_control again once they allow it",
  );
}
