import { parseAccountProfile, type AccountDetail, type AccountView } from "@zcode/shared";

/**
 * Supplies the Clerk human session. The production source is the Account window
 * (official Clerk SDK); a deterministic test source exists for non-packaged builds.
 * Tokens flow through here in memory only and are never persisted or logged.
 */
export interface AccountTokenSource {
  /** Starts the interactive sign-in surface. Session results arrive via onSession. */
  signIn(): Promise<void>;
  /** A fresh session token, or null when there is no session. */
  getToken(): Promise<string | null>;
  signOut(): Promise<void>;
  /** `true` = a Clerk session exists, `false` = none / sign-in dismissed. */
  onSession(listener: (signedIn: boolean) => void): () => void;
}

export interface AccountPreferenceStore {
  read(): Promise<"undecided" | "local">;
  write(choice: "local"): Promise<void>;
}

export interface AccountSessionControllerDeps {
  /** null = this build has no account configuration (local-only). */
  apiBaseUrl: string | null;
  tokenSource: AccountTokenSource | null;
  preference: AccountPreferenceStore;
  fetch: typeof fetch;
  requestTimeoutMs?: number;
  /** False when the session cannot survive a restart (no secure storage). Default true. */
  rememberSession?: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Single owner of the account projection. Every async result is fenced by a
 * generation so a late response can never resurrect a signed-out or switched account.
 */
export function createAccountSessionController(deps: AccountSessionControllerDeps) {
  const configured = Boolean(deps.apiBaseUrl && deps.tokenSource);
  let view: AccountView = {
    configured,
    choice: "undecided",
    phase: "signedOut",
    ...(deps.rememberSession === false ? { rememberSession: false } : {}),
  };
  let generation = 0;
  const listeners = new Set<(view: AccountView) => void>();
  let disposeSession: (() => void) | null = null;

  const publish = (next: AccountView) => {
    view = next;
    for (const listener of listeners) listener(view);
  };
  const set = (patch: Partial<AccountView>, drop: Array<keyof AccountView> = []) => {
    const next = { ...view, ...patch };
    for (const key of drop) delete next[key];
    publish(next);
  };

  async function checkAdmission(attempt: number): Promise<void> {
    if (!deps.tokenSource || !deps.apiBaseUrl) return;
    set({ phase: "admissionChecking" }, ["detail"]);
    let token: string | null;
    try {
      token = await deps.tokenSource.getToken();
    } catch {
      token = null;
    }
    if (attempt !== generation) return;
    if (!token) {
      set({ phase: "signedOut" }, ["profile", "detail"]);
      return;
    }
    const settle = (patch: Partial<AccountView>, drop: Array<keyof AccountView> = []) => {
      // Stale-result rule: only the latest attempt may write the projection.
      if (attempt === generation) set(patch, drop);
    };
    const offline = (detail: AccountDetail) => settle({ phase: "offline", detail });
    try {
      const response = await deps.fetch(new URL("/v1/me", deps.apiBaseUrl), {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(deps.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS),
        redirect: "error",
      });
      if (response.status === 200) {
        const profile = parseAccountProfile(await response.json().catch(() => null));
        if (profile) settle({ phase: "ready", profile }, ["detail"]);
        else offline("failed");
      } else if (response.status === 403) {
        settle({ phase: "denied", detail: "not_admitted" }, ["profile"]);
      } else if (response.status === 401) {
        // The backend rejected the Clerk session: treat as signed out, keep local mode.
        settle({ phase: "signedOut", detail: "session_rejected" }, ["profile"]);
      } else {
        offline(response.status >= 500 ? "unreachable" : "failed");
      }
    } catch {
      offline("unreachable");
    }
  }

  function onSession(signedIn: boolean) {
    if (!signedIn) {
      // Dismissing sign-in, or Clerk ending the session, returns to signed out.
      if (view.phase !== "signedOut") {
        generation += 1;
        set({ phase: "signedOut" }, ["profile", "detail"]);
      }
      return;
    }
    generation += 1;
    set({ phase: "authenticated" }, ["detail"]);
    void checkAdmission(generation);
  }

  return {
    getView: (): AccountView => view,
    onViewChanged(listener: (next: AccountView) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Reads the persisted preference and attaches to the session source. Never throws. */
    async start(): Promise<void> {
      const choice = await deps.preference.read().catch(() => "undecided" as const);
      publish({ ...view, choice });
      disposeSession?.();
      disposeSession = deps.tokenSource?.onSession(onSession) ?? null;
    },
    async signIn(): Promise<void> {
      if (!configured || !deps.tokenSource) return;
      generation += 1;
      set({ phase: "authenticating" }, ["detail"]);
      try {
        await deps.tokenSource.signIn();
      } catch {
        set({ phase: "signedOut", detail: "failed" });
      }
    },
    /** Account sign-out only: provider config and local conversations are not touched. */
    async signOut(): Promise<void> {
      generation += 1;
      set({ phase: "signedOut" }, ["profile", "detail"]);
      try {
        await deps.tokenSource?.signOut();
      } catch {
        // Offline sign-out still removes local account access; server revocation is not claimed.
      }
    },
    async refresh(): Promise<void> {
      if (!configured) return;
      if (view.phase === "ready" || view.phase === "offline" || view.phase === "denied") {
        generation += 1;
        await checkAdmission(generation);
      }
    },
    async chooseLocal(): Promise<void> {
      await deps.preference.write("local").catch(() => undefined);
      set({ choice: "local" });
    },
    dispose() {
      disposeSession?.();
      listeners.clear();
    },
  };
}

export type AccountSessionController = ReturnType<typeof createAccountSessionController>;
