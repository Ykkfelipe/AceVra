import type { TokenStorage } from "@clerk/electron";

/** The one Electron signal consulted: whether OS-backed encryption is usable. */
export interface SecureStorageProbe {
  isEncryptionAvailable(): boolean;
}

export interface SelectedAccountTokenStorage {
  storage: TokenStorage;
  /** True only when tokens are OS-encrypted at rest and survive restart. */
  persistent: boolean;
}

/**
 * Chooses Clerk's token storage BEFORE any persistence code runs. When encryption is
 * unavailable the secure factory is never invoked (so no Keychain operation, no dialog)
 * and tokens live in memory only. There is no plaintext fallback. If the secure store
 * later fails, it fails closed to memory for the rest of the process, with a sanitized
 * diagnostic and no retry.
 */
export function selectAccountTokenStorage(deps: {
  probe: SecureStorageProbe;
  createSecure: () => TokenStorage;
  diagnostic?: (message: string) => void;
}): SelectedAccountTokenStorage {
  const memory = new Map<string, string>();
  const memoryStorage: TokenStorage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => void memory.set(key, value),
    removeItem: (key) => void memory.delete(key),
  };
  let available = false;
  try {
    available = deps.probe.isEncryptionAvailable() === true;
  } catch {
    available = false;
  }
  if (!available) {
    deps.diagnostic?.("account session storage: secure storage unavailable, memory-only");
    return { storage: memoryStorage, persistent: false };
  }
  const secure = deps.createSecure();
  let failedClosed = false;
  const guard =
    <Args extends unknown[], Result>(
      operation: (...args: Args) => Result | Promise<Result>,
      fallback: (...args: Args) => Result,
    ) =>
    async (...args: Args): Promise<Result> => {
      if (failedClosed) return fallback(...args);
      try {
        return await operation(...args);
      } catch {
        failedClosed = true;
        deps.diagnostic?.("account session storage: secure storage failed, memory-only");
        return fallback(...args);
      }
    };
  return {
    persistent: true,
    storage: {
      getItem: guard(secure.getItem, memoryStorage.getItem as (key: string) => string | null),
      setItem: guard(secure.setItem, memoryStorage.setItem as (key: string, value: string) => void),
      removeItem: guard(secure.removeItem, memoryStorage.removeItem as (key: string) => void),
    },
  };
}
