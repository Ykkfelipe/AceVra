import type { NodeCapability } from "./capabilities.js";

export interface PairingCreated {
  pairingId: string;
  secret: string;
  code: string;
  expiresAt: string;
}

/** Thin HTTP client for the unauthenticated, secret-proven pairing endpoints. */
export function createPairingApi(base: string, fetchImpl: typeof fetch = fetch) {
  async function post(path: string, body: unknown) {
    const response = await fetchImpl(new URL(path, base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: response.status, json: json ?? {} };
  }
  return {
    async create(input: {
      publicKey: string;
      displayName: string;
      platform: string;
      capabilities: NodeCapability[];
    }): Promise<PairingCreated> {
      const r = await post("/v1/pairings", input);
      if (r.status !== 201) throw new Error(`Pairing request refused (${r.status})`);
      return r.json as unknown as PairingCreated;
    },
    async status(id: string, secret: string) {
      const r = await post(`/v1/pairings/${id}/status`, { secret });
      return r.status === 200 ? (r.json.status as string) : r.status === 404 ? "unknown" : "error";
    },
    async challenge(id: string, secret: string): Promise<string> {
      const r = await post(`/v1/pairings/${id}/challenge`, { secret });
      if (r.status !== 200) throw new Error(`Pairing challenge refused (${r.status})`);
      return r.json.nonce as string;
    },
    async claim(id: string, input: { secret: string; nonce: string; signature: string }) {
      const r = await post(`/v1/pairings/${id}/claim`, input);
      if (r.status !== 201) throw new Error(`Pairing claim refused (${r.status})`);
      return r.json as unknown as { deviceId: string; keyId: string };
    },
  };
}
export const claimMessage = (pairingId: string, nonce: string) =>
  `acevra-pair-claim:v1:${pairingId}:${nonce}`;
