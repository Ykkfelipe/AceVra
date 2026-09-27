/**
 * CUA-4: per-runtime-session target identity bookkeeping.
 *
 * Only pids/windows the Helper actually listed in this runtime session are remembered, so an
 * observation target is named solely from positively identified Helper data; never guessed.
 */
const MAX_IDENTITY_SESSIONS = 16;
const MAX_IDENTITY_ENTRIES = 256;
const MAX_IDENTITY_TEXT = 160;

export function identityText(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, MAX_IDENTITY_TEXT)
    : undefined;
}

function integerOf(value) {
  return Number.isInteger(value) ? value : undefined;
}

function boundedSet(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_IDENTITY_ENTRIES) map.delete(map.keys().next().value);
}

export function createSessionIdentityRegistry() {
  const identities = new Map();

  function identityFor(sessionId) {
    let identity = identities.get(sessionId);
    if (!identity) {
      identity = { apps: new Map(), windows: new Map() };
      identities.set(sessionId, identity);
      while (identities.size > MAX_IDENTITY_SESSIONS)
        identities.delete(identities.keys().next().value);
    }
    return identity;
  }

  return {
    remember(sessionId, method, raw) {
      if (!sessionId || !raw || typeof raw !== "object") return;
      const identity = identityFor(sessionId);
      if (method === "list_apps" && Array.isArray(raw.apps)) {
        for (const app of raw.apps) {
          const pid = integerOf(app?.pid);
          if (pid === undefined || pid <= 0) continue;
          boundedSet(identity.apps, pid, {
            name: identityText(app?.name),
            bundleId: identityText(app?.bundle_id),
          });
        }
      }
      if (method === "list_windows" && Array.isArray(raw.windows)) {
        for (const window of raw.windows) {
          const windowId = integerOf(window?.window_id);
          const pid = integerOf(window?.pid);
          if (windowId === undefined || windowId < 0 || pid === undefined || pid <= 0) continue;
          boundedSet(identity.windows, windowId, {
            pid,
            title: identityText(window?.title),
            owner: identityText(window?.owner),
          });
        }
      }
    },

    target(sessionId, args) {
      const pid = integerOf(args?.pid);
      if (pid === undefined) return undefined;
      const windowId = integerOf(args?.window_id);
      const identity = sessionId ? identities.get(sessionId) : undefined;
      const app = identity?.apps.get(pid);
      const window = windowId === undefined ? undefined : identity?.windows.get(windowId);
      const sameOwner = window && window.pid === pid ? window : undefined;
      const name = app?.name ?? sameOwner?.owner;
      return {
        pid,
        ...(windowId !== undefined ? { windowId } : {}),
        ...(name ? { app: name } : {}),
        ...(app?.bundleId ? { bundleId: app.bundleId } : {}),
        ...(sameOwner?.title ? { window: sameOwner.title } : {}),
      };
    },

    forget(sessionId) {
      identities.delete(sessionId);
    },
  };
}
