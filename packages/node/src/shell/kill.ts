import { spawn, type ChildProcess } from "node:child_process";

/** Terminates the whole process tree. Windows: taskkill /T /F. POSIX: process-group signal. */
export function killTree(child: ChildProcess, graceMs = 3000): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on(
      "error",
      () => child.kill(),
    );
    return;
  }
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name); // the child leads its own process group (detached)
    } catch {
      try {
        child.kill(name);
      } catch {
        // already gone
      }
    }
  };
  signal("SIGTERM");
  setTimeout(
    () => child.exitCode === null && child.signalCode === null && signal("SIGKILL"),
    graceMs,
  ).unref();
}
