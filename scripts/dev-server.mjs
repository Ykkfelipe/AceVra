import { spawn } from "node:child_process";
import { createCustomForkDevEnvironment } from "./custom-fork-dev-env.mjs";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(pnpm, ["--filter", "@zcode/server", "dev:watch"], {
  env: createCustomForkDevEnvironment(),
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("error", (error) => {
  console.error("[acevra-dev-server] failed to start:", error.message);
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal && !["SIGINT", "SIGTERM"].includes(signal)) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
