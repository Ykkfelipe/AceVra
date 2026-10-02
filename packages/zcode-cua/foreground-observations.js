// Foreground-observation ledger for screen takeover (specs/computer-use.md "Screen takeover").
//
// 根因（installed be1b1348 实测 + 源码核对）：Helper 只在观察**带 window_id** 时才签发
// foreground_geometry（ForegroundControl.swift 的 rememberObservation 要求 windowId 非空），
// 而模型面的 get_app_state 只被宣传成 { pid }，于是 foreground_geometry 从未出现过，
// 每次 acquire_control 都只能撞 stale_geometry。更糟的是授权卡在 Helper 拒绝之前就弹出来：
// 用户点了 Allow，请求却注定不可能成功——用真实的同意换一次必然失败。
//
// 所以运行时要记住「哪次观察真的拿到了前台几何」，acquire_control 在弹卡之前先核对；
// 没有几何就如实拒绝，绝不先问用户。

const FOREGROUND_OBSERVATION_LIMIT = 64;

/**
 * Records the foreground observation ids this session actually received. Only the Helper's
 * `foreground_geometry` counts: the semantic `tree.observation_id` is a different id space and
 * the Helper refuses it (stale_geometry), so it must never open the approval gate.
 */
export function rememberForegroundObservations(store, sessionId, result) {
  const observationId = result?.foreground_geometry?.observation_id;
  if (!sessionId || typeof observationId !== "string" || !observationId) return;
  const seen = store.get(sessionId) ?? new Set();
  seen.add(observationId);
  while (seen.size > FOREGROUND_OBSERVATION_LIMIT) {
    const oldest = seen.values().next().value;
    seen.delete(oldest);
  }
  store.set(sessionId, seen);
}

/** True when this observation id came from a Helper-issued foreground geometry. */
export function hasForegroundObservation(store, sessionId, observationId) {
  if (!sessionId || typeof observationId !== "string") return false;
  return store.get(sessionId)?.has(observationId) === true;
}

/** Session teardown; keeps the ledger from outliving the conversation that produced it. */
export function forgetForegroundObservations(store, sessionId) {
  store.delete(sessionId);
}
