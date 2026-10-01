import type { AccountTokenSource } from "./accountSessionController.js";

/**
 * Deterministic stand-in for the Clerk window, used only by acceptance harnesses.
 * The token is a backend-verifiable test JWT supplied by the harness; the backend still
 * runs its full verification and admission path. Never constructed for packaged builds.
 */
export function createAccountTestTokenSource(token: string): AccountTokenSource {
  let signedIn = false;
  const listeners = new Set<(signedIn: boolean) => void>();
  const emit = (value: boolean) => {
    signedIn = value;
    for (const listener of listeners) listener(value);
  };
  return {
    async signIn() {
      queueMicrotask(() => emit(true));
    },
    async getToken() {
      return signedIn ? token : null;
    },
    async signOut() {
      emit(false);
    },
    onSession(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The test source is honoured only for unpackaged builds with an explicit token. */
export function resolveTestTokenSource(
  env: NodeJS.ProcessEnv,
  options: { isPackaged: boolean },
): AccountTokenSource | null {
  const token = env.ACEVRA_ACCOUNT_TEST_TOKEN?.trim();
  return !options.isPackaged && token ? createAccountTestTokenSource(token) : null;
}
