// Shared live-verification helpers for the CUA-1.75 acceptance harness
// (run-cua175-verification.mjs). Deliberately dependency-light: raw socket/client plumbing
// only, so the runner reads as the acceptance matrix itself.

import { connect } from "node:net";
import { spawn } from "node:child_process";

/** Launch a helper binary directly with an explicit argv; resolves on process exit. */
export function launchDirect(argv) {
  return new Promise((resolveLaunch) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => resolveLaunch({ code, stderr: stderr.trim() }));
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, 20_000).unref();
  });
}

/** A raw claimant: one socket, one hello line, resolves with the host's first response. */
export function speakHello(socketPath, helloResult) {
  return new Promise((resolveRefusal) => {
    const socket = connect(socketPath);
    let buffer = "";
    socket.on("error", () => resolveRefusal(null));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      socket.destroy();
      try {
        resolveRefusal(JSON.parse(buffer.slice(0, index))?.error ?? null);
      } catch {
        resolveRefusal(null);
      }
    });
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ ok: true, result: { type: "helper_hello", ...helloResult } })}\n`,
      );
    });
    setTimeout(() => resolveRefusal(null), 15_000).unref();
  });
}

/** One observe-style call through the relay as a token-bearing client (the production hop). */
export function clientMethod(socketPath, token, method, params) {
  return new Promise((resolveCall, rejectCall) => {
    const socket = connect(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      rejectCall(new Error("timeout"));
    }, 20_000);
    socket.on("error", rejectCall);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        const parsed = JSON.parse(buffer.slice(0, index));
        if (parsed?.ok === true) resolveCall(parsed.result);
        else {
          rejectCall(Object.assign(new Error(parsed?.error?.message ?? "failed"), parsed?.error));
        }
      } catch (error) {
        rejectCall(error);
      }
    });
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ id: "1", method, ...(params ? { params } : {}), token })}\n`,
      );
    });
  });
}

export const waitExit = (pid) =>
  new Promise((resolveWait) => {
    const timer = setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch {
        clearInterval(timer);
        resolveWait();
      }
    }, 100);
  });

/** Drop the current helper connection and wait until the relay has no helper. */
export async function dropCurrentHelper(host) {
  const pid = host.admittedHelper?.pid;
  if (typeof pid === "number") {
    try {
      process.kill(pid);
    } catch {}
    await waitExit(pid);
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
}
