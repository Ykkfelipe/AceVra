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
  const deadline = now() + waitMs;
  while (state === "pending" && now() < deadline) {
    await sleep(TAKEOVER_POLL_MS);
    state = (await leaseAuthority.takeoverStatus(owner))?.state;
  }
  if (state === "granted") return;
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
