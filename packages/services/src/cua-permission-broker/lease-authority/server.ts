import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { createLeaseAuthority, type LeaseAuthorityOptions } from "./authority.js";
import type { ComputerUseActivityReport, LeaseAuthority } from "./contract.js";

export interface LeaseAuthorityServer {
  readonly authority: LeaseAuthority;
  readonly socketPath: string;
  readonly token: string;
  close(): Promise<void>;
}

export async function startLeaseAuthorityServer(
  dataRoot: string,
  options: LeaseAuthorityOptions = {},
): Promise<LeaseAuthorityServer> {
  const directory = join(dataRoot, "computer-use", "lease-authority");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const socketPath = join(directory, "authority.sock");
  rmSync(socketPath, { force: true });
  const token = randomBytes(32).toString("hex");
  const authority = createLeaseAuthority(options);
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      void handleLine(socket, line);
    });
  });

  async function handleLine(socket: import("node:net").Socket, line: string): Promise<void> {
    try {
      const request = JSON.parse(line) as {
        token?: string;
        method?: string;
        params?: Record<string, unknown>;
      };
      const presented = request.token ?? "";
      const left = createHash("sha256").update(presented).digest();
      const right = createHash("sha256").update(token).digest();
      if (!timingSafeEqual(left, right))
        throw Object.assign(new Error("unauthorized"), { code: "unauthorized" });
      const params = request.params ?? {};
      let result: unknown;
      switch (request.method) {
        case "begin_acquire":
          result = await authority.beginAcquire(params as { session: string; task: string });
          break;
        case "commit_acquire":
          result = await authority.commitAcquire(
            String(params.leaseId),
            String(params.helperLeaseId),
            String(params.helperRequirement),
          );
          break;
        case "release":
          result = await authority.release(
            String(params.leaseId),
            params.reason ? String(params.reason) : undefined,
          );
          break;
        case "stop":
          result = await authority.stop();
          break;
        case "status":
          result = authority.getStatus() ?? null;
          break;
        // CUA-4：运行时只能读取 admission 并上报活动；pause/resume/stop 只属于拥有会话的 UI，
        // 不经 sideband 暴露，模型无法自行暂停、恢复或停止。
        case "admission":
          result = authority.getAdmission();
          break;
        case "report_activity":
          authority.reportActivity(params as unknown as ComputerUseActivityReport);
          result = { accepted: true };
          break;
        default:
          throw Object.assign(new Error("unknown method"), { code: "bad_request" });
      }
      socket.write(`${JSON.stringify({ ok: true, result })}\n`);
    } catch (error) {
      socket.write(
        `${JSON.stringify({ ok: false, error: { code: (error as { code?: string }).code ?? "failed" } })}\n`,
      );
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  chmodSync(socketPath, 0o600);
  return {
    authority,
    socketPath,
    token,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(socketPath, { force: true });
    },
  };
}
