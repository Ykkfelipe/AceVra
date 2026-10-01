export type WorkerActor = "agent" | "human";

export type WorkerResponse =
  | { ok: true; status: number; json: Record<string, any> }
  | {
      ok: false;
      status: number;
      code: string | null;
      reason: string | null;
      json: Record<string, any> | null;
    };

/**
 * HTTP client for one computer's worker through the local tunnel port. The token goes in a
 * header only; it is never logged or put in a URL.
 */
export function createWorkerClient(deps: {
  port: number;
  token: string;
  fetch: typeof fetch;
  timeoutMs?: number;
}) {
  const base = `http://127.0.0.1:${deps.port}`;
  const headers = (actor?: WorkerActor): Record<string, string> => ({
    "content-type": "application/json",
    "x-acevra-token": deps.token,
    ...(actor ? { "x-acevra-actor": actor } : {}),
  });

  async function request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    actor?: WorkerActor,
    timeoutMs = deps.timeoutMs ?? 15_000,
  ): Promise<WorkerResponse> {
    let response: Response;
    try {
      response = await deps.fetch(`${base}${path}`, {
        method,
        headers: headers(actor),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, status: 0, code: "unreachable", reason: null, json: null };
    }
    const json = (await response.json().catch(() => null)) as Record<string, any> | null;
    if (response.ok && json && json.ok !== false)
      return { ok: true, status: response.status, json };
    const detail = json?.detail && typeof json.detail === "object" ? json.detail : null;
    return {
      ok: false,
      status: response.status,
      code: typeof detail?.code === "string" ? detail.code : null,
      reason:
        typeof detail?.reason === "string"
          ? detail.reason
          : typeof json?.error === "string"
            ? json.error.slice(0, 120)
            : null,
      json,
    };
  }

  return {
    port: deps.port,
    get: (path: string) => request("GET", path),
    post: (path: string, body?: unknown, actor?: WorkerActor, timeoutMs?: number) =>
      request("POST", path, body ?? {}, actor, timeoutMs),
    async screenPng(): Promise<Buffer | null> {
      try {
        const response = await deps.fetch(`${base}/screen`, {
          headers: headers(),
          signal: AbortSignal.timeout(15_000),
        });
        return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
      } catch {
        return null;
      }
    },
    viewSocketUrl: () => `ws://127.0.0.1:${deps.port}/ws/view`,
    token: () => deps.token,
  };
}
export type WorkerClient = ReturnType<typeof createWorkerClient>;
