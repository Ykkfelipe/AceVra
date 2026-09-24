import net from "node:net";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

const SOCKET_ENV = "ZCODE_CUA_LEASE_AUTHORITY_SOCKET";
const TOKEN_ENV = "ZCODE_CUA_LEASE_AUTHORITY_TOKEN";

function tokenMatches(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function createLeaseAuthorityClient(env = process.env) {
  const socketPath = env[SOCKET_ENV]?.trim();
  const token = env[TOKEN_ENV]?.trim();
  if (!socketPath || !token) return undefined;
  return {
    async request(method, params = {}) {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        let buffer = "";
        socket.setEncoding("utf8");
        socket.once("connect", () =>
          socket.write(`${JSON.stringify({ token, id: randomUUID(), method, params })}\n`),
        );
        socket.once("data", (chunk) => {
          buffer += chunk;
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          socket.destroy();
          try {
            const response = JSON.parse(buffer.slice(0, newline));
            if (response.ok === true) resolve(response.result);
            else reject(new Error(response.error?.code ?? "lease_authority_failed"));
          } catch (error) {
            reject(error);
          }
        });
        socket.once("error", reject);
      });
    },
    beginAcquire(owner) {
      return this.request("begin_acquire", owner);
    },
    commitAcquire(leaseId, helperLeaseId, helperRequirement) {
      return this.request("commit_acquire", { leaseId, helperLeaseId, helperRequirement });
    },
    release(leaseId, reason) {
      return this.request("release", { leaseId, reason });
    },
    stop() {
      return this.request("stop");
    },
  };
}

export { tokenMatches };
