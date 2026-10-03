import type {
  AccountDevice,
  AccountDevicesView,
  AccountPairingDecisionResult,
  AccountPairingLookupResult,
  AccountPairingPreview,
} from "@zcode/shared";

export interface DeviceDescriptor {
  platform: AccountDevice["platform"];
  displayName: string;
  capabilities: AccountDevice["capabilities"];
}

export interface AccountDevicesDeps {
  apiBaseUrl: string;
  /** Fresh Clerk session token per request (human-session-backed registration in M2B). */
  getToken(): Promise<string | null>;
  fetch: typeof fetch;
  installationId(): Promise<string>;
  describe(): DeviceDescriptor | Promise<DeviceDescriptor>;
  heartbeatMs?: number;
  timers?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
  /**
   * Called when any account request comes back 401 — the bearer can no longer prove
   * who it is. The session controller owns the transition to signed out; the device
   * client never decides what a rejected session means.
   */
  onUnauthorized?(): void;
  /**
   * Mints a new installation identity for this machine. Only used to recover from a
   * conflict; the backend still binds each id to exactly one account.
   */
  resetInstallationId?(): Promise<string>;
}

const EMPTY: AccountDevicesView = { registration: "none", thisDeviceId: null, devices: [] };

/**
 * Owns this installation's relationship to the account device registry. The backend is
 * authoritative: ownership, presence and capability facts come from it. Sign-out only stops
 * the heartbeat; it never unregisters the device or touches the local installation id.
 */
export function createAccountDevices(deps: AccountDevicesDeps) {
  const timers = deps.timers ?? { setInterval, clearInterval };
  let generation = 0;
  let registration: AccountDevicesView["registration"] = "none";
  let thisDeviceId: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function call(method: string, path: string, body?: unknown) {
    const token = await deps.getToken();
    if (!token) return null;
    try {
      const response = await deps.fetch(new URL(path, deps.apiBaseUrl), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      // A 401 is a session-level fact, not a per-endpoint one. Report it once here so
      // every caller — heartbeat, register, list, rename, revoke, pairing — surfaces a
      // rejected session instead of degrading into "devices unavailable".
      if (response.status === 401) deps.onUnauthorized?.();
      return { status: response.status, json };
    } catch {
      return null;
    }
  }

  function stopHeartbeat() {
    if (timer) timers.clearInterval(timer);
    timer = null;
  }

  async function beat(attempt: number) {
    if (attempt !== generation || !thisDeviceId) return;
    const result = await call("POST", `/v1/devices/${thisDeviceId}/heartbeat`);
    if (attempt !== generation) return;
    if (result?.status === 403 && result.json?.error === "device_revoked") {
      registration = "revoked";
      stopHeartbeat();
    }
  }

  async function view(): Promise<AccountDevicesView> {
    if (registration === "none") return { ...EMPTY };
    const result = await call("GET", "/v1/devices");
    const devices = Array.isArray(result?.json?.devices)
      ? (result!.json!.devices as AccountDevice[])
      : [];
    return {
      registration: result && result.status === 200 ? registration : "unavailable",
      thisDeviceId,
      devices,
    };
  }

  /** Registers (idempotently) and starts the heartbeat. Call when the account is ready. */
  async function start(): Promise<void> {
    generation += 1;
    const attempt = generation;
    stopHeartbeat();
    const installationId = await deps.installationId();
    const result = await call("POST", "/v1/devices/register", {
      installationId,
      type: "desktop",
      ...(await deps.describe()),
    });
    if (attempt !== generation) return;
    if (!result) {
      registration = "none";
      return;
    }
    const device = result.json?.device as AccountDevice | undefined;
    if (result.status === 200 || result.status === 201) {
      registration = "registered";
      thisDeviceId = device?.id ?? null;
      timer = timers.setInterval(() => void beat(attempt), deps.heartbeatMs ?? 30_000);
      timer.unref?.();
    } else if (result.status === 409) {
      // Installation belongs to another account: refuse takeover, keep local use.
      // The user can recover with `resetInstallation()`.
      registration = "conflict";
      thisDeviceId = null;
    } else if (result.status === 403 && result.json?.error === "device_revoked") {
      registration = "revoked";
      thisDeviceId = null;
    } else {
      registration = "unavailable";
    }
  }

  return {
    /** Authenticated control-plane call (null when signed out or unreachable). Shared with tasks. */
    call,
    start,
    thisDeviceId: () => thisDeviceId,
    /**
     * Recovery from `conflict`: this machine's installation id is already bound to
     * another account, so mint a fresh one and register again.
     *
     * This never transfers or reassigns an existing device. The previous account keeps
     * its row; this machine simply presents as a new device to the current account.
     */
    async resetInstallation(): Promise<AccountDevicesView> {
      if (!deps.resetInstallationId) return view();
      generation += 1;
      stopHeartbeat();
      thisDeviceId = null;
      registration = "none";
      await deps.resetInstallationId();
      await start();
      return view();
    },
    /** Account left `ready`: stop talking to the registry. Local identity is untouched. */
    stop(): void {
      generation += 1;
      stopHeartbeat();
      registration = "none";
      thisDeviceId = null;
    },
    list: view,
    async rename(id: string, displayName: string) {
      await call("PATCH", `/v1/devices/${encodeURIComponent(id)}`, { displayName });
      return view();
    },
    /** The code is the only way to discover a pending node; there is no global pending list. */
    async lookupPairing(code: string): Promise<AccountPairingLookupResult> {
      const result = await call("POST", "/v1/pairings/lookup", { code });
      if (!result) return { status: "unavailable" };
      if (result.status === 200 && result.json?.pairing) {
        return { status: "found", pairing: result.json.pairing as AccountPairingPreview };
      }
      if (result.status === 429) return { status: "too_many_attempts" };
      return { status: result.status === 404 ? "not_found" : "unavailable" };
    },
    async decidePairing(
      id: string,
      decision: "approve" | "reject",
    ): Promise<AccountPairingDecisionResult> {
      const result = await call("POST", `/v1/pairings/${encodeURIComponent(id)}/${decision}`);
      if (!result) return { status: "unavailable" };
      if (result.status === 200)
        return { status: decision === "approve" ? "approved" : "rejected" };
      return {
        status: result.status === 409 || result.status === 404 ? "not_pending" : "unavailable",
      };
    },
    async revoke(id: string) {
      const result = await call("POST", `/v1/devices/${encodeURIComponent(id)}/revoke`);
      if (result?.status === 200 && id === thisDeviceId) {
        registration = "revoked";
        stopHeartbeat();
      }
      return view();
    },
  };
}
export type AccountDevices = ReturnType<typeof createAccountDevices>;
