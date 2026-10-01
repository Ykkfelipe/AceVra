import { createPairingApi, claimMessage } from "./api.js";
import type { NodeCapability } from "./capabilities.js";
import type { NodePaths } from "./dataRoot.js";
import type { NodeIdentity } from "./identity.js";
import type { NodeLogger } from "./log.js";
import { readState, writeState, type NodeState } from "./state.js";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * Pairing = request → human approval (in AceVra) → claim with proof of key possession.
 * The approved short code alone never yields a device: the node must sign a server nonce
 * with the private key matching the public key it presented.
 */
export async function pairNode(deps: {
  paths: NodePaths;
  identity: NodeIdentity;
  state: NodeState;
  capabilities: NodeCapability[];
  httpBase: string;
  fetch?: typeof fetch;
  onCode(code: string, expiresAt: string): void;
  log: NodeLogger;
  signal?: AbortSignal;
  pollMs?: number;
}): Promise<NodeState> {
  const api = createPairingApi(deps.httpBase, deps.fetch);
  let state = deps.state;
  let pairing = state.pairing;
  const fresh = !pairing || Date.parse(pairing.expiresAt) <= Date.now();
  if (fresh) {
    const created = await api.create({
      publicKey: deps.identity.publicKey,
      displayName: state.displayName,
      platform: state.platform,
      capabilities: deps.capabilities,
    });
    pairing = {
      pairingId: created.pairingId,
      secret: created.secret,
      code: created.code,
      expiresAt: created.expiresAt,
    };
    state = { ...state, pairing };
    await writeState(deps.paths, state);
    await deps.log("pairing-created");
  }
  const active = pairing!;
  deps.onCode(active.code, active.expiresAt);

  while (!deps.signal?.aborted) {
    const status = await api.status(active.pairingId, active.secret).catch(() => "error");
    if (status === "approved") {
      const nonce = await api.challenge(active.pairingId, active.secret);
      const claimed = await api.claim(active.pairingId, {
        secret: active.secret,
        nonce,
        signature: deps.identity.sign(claimMessage(active.pairingId, nonce)),
      });
      const { pairing: _done, ...rest } = state;
      state = { ...rest, deviceId: claimed.deviceId, keyId: claimed.keyId };
      await writeState(deps.paths, state);
      await deps.log("paired");
      return state;
    }
    if (status === "rejected" || status === "expired" || status === "unknown") {
      const { pairing: _gone, ...rest } = state;
      await writeState(deps.paths, rest);
      await deps.log("pairing-ended", { status });
      throw new Error(
        status === "rejected"
          ? "The pairing was rejected."
          : "The pairing code expired. Run the command again.",
      );
    }
    await sleep(deps.pollMs ?? 2000, deps.signal);
  }
  throw new Error("Pairing cancelled.");
}
export { readState };
