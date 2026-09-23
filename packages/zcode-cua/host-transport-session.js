// CUA-1.5 session directory lifecycle for the host-owned transport.
//
// Split from host-transport.js: this owns nothing but the on-disk identity of one session —
// a fresh random directory (0700), the socket file inside it (0600), and the owner record used
// to prune directories whose host process is gone. Short names are a hard constraint here:
// macOS's sockaddr_un holds 104 bytes of path including the NUL, and a deep data root plus a
// long session name would fail listen() with EINVAL.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Dead session directories (owner pid gone, or no readable owner) are stale weight only. */
export function pruneDeadSessions(sessionsRoot) {
  let entries = [];
  try {
    entries = readdirSync(sessionsRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    const candidate = join(sessionsRoot, entry);
    let alive = false;
    try {
      const owner = JSON.parse(readFileSync(join(candidate, "session.json"), "utf8") ?? "{}");
      const pid = typeof owner.pid === "number" ? owner.pid : 0;
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
    } catch {
      alive = false;
    }
    if (!alive) {
      try {
        rmSync(candidate, { recursive: true, force: true });
      } catch {
        // best effort; a directory that will not leave is harmless clutter
      }
    }
  }
}

/**
 * Create the session directory for one transport session. Returns
 * `{ sessionDir, socketPath, ownerFilePath }` — the paths the caller must bind and clean up;
 * the socket file itself is chmod'ed 0600 by the caller once listening.
 */
export function createSessionDirectory(sessionsRoot) {
  mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
  chmodSync(sessionsRoot, 0o700);
  pruneDeadSessions(sessionsRoot);
  const sessionDir = join(sessionsRoot, `s-${randomBytes(8).toString("hex")}`);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  chmodSync(sessionDir, 0o700);
  const socketPath = join(sessionDir, "b.sock");
  // macOS sockaddr_un holds 104 bytes of path including the NUL, so 103 usable.
  if (Buffer.byteLength(socketPath, "utf8") > 103) {
    rmSync(sessionDir, { recursive: true, force: true });
    throw new Error("the runtime data root path is too deep for a unix session socket");
  }
  const ownerFilePath = join(sessionDir, "session.json");
  writeFileSync(
    ownerFilePath,
    `${JSON.stringify({
      pid: process.pid,
      socket_path: socketPath,
      started_at: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  return { sessionDir, socketPath, ownerFilePath };
}

export function removeSessionDirectory(sessionDir) {
  rmSync(sessionDir, { recursive: true, force: true });
}

/**
 * Create the session directory AND the listening server for one session. The returned server
 * has its socket chmod'ed 0600 once listening; `stopSession` is its exact inverse. This keeps
 * the relay module free of filesystem/socket plumbing.
 */
export async function startSessionServer(sessionsRoot) {
  const { sessionDir, socketPath } = createSessionDirectory(sessionsRoot);
  const { createServer } = await import("node:net");
  const { unlinkSync, chmodSync } = await import("node:fs");
  try {
    unlinkSync(socketPath);
  } catch {
    // A fresh random directory has no stale socket; the unlink is defence in depth.
  }
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => {
      try {
        chmodSync(socketPath, 0o600);
      } catch {
        // Platform quirks aside, the 0700 session directory already gates access.
      }
      resolveListen();
    });
  });
  return { server, socketPath, sessionDir };
}

/** Exact inverse of `startSessionServer`; every step is best-effort. */
export async function stopSessionServer(server, socketPath, sessionDir) {
  if (server) {
    await new Promise((resolveClose) => {
      server.close(() => resolveClose());
      // A socket with no connections closes promptly; the guard covers listen-phase races.
      setTimeout(resolveClose, 250).unref?.();
    });
  }
  if (socketPath) {
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(socketPath);
    } catch {
      // already gone
    }
  }
  if (sessionDir) removeSessionDirectory(sessionDir);
}
