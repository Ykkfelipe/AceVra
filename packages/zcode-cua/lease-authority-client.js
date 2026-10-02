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
    async request(method, params = {}, requestOptions = {}) {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        let buffer = "";
        // CUA-4 的 admission/活动上报位于每次 Computer Use 调用路径上：必须有上限，
        // sideband 卡住时只能失败而不能让动作无限等待。既有方法不传 timeoutMs，行为不变。
        const timeoutMs = requestOptions.timeoutMs;
        if (typeof timeoutMs === "number" && timeoutMs > 0) {
          socket.setTimeout(timeoutMs, () => {
            socket.destroy();
            reject(
              Object.assign(new Error("lease authority request timed out"), { code: "timeout" }),
            );
          });
        }
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
            else {
              // Phase 2：保留 authority 的 code。以前只放进 message，上层读 error.code 得到
              // undefined，最终在模型侧变成 "(unknown)"。
              const code = response.error?.code ?? "lease_authority_failed";
              reject(
                Object.assign(new Error(response.error?.message ?? code), {
                  code,
                }),
              );
            }
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
    commitAcquire(leaseId, helperLeaseId, helperRequirement, helperConnectionGeneration) {
      return this.request("commit_acquire", {
        leaseId,
        helperLeaseId,
        helperRequirement,
        ...(Number.isInteger(helperConnectionGeneration) ? { helperConnectionGeneration } : {}),
      });
    },
    release(leaseId, reason) {
      return this.request("release", { leaseId, reason });
    },
    stop() {
      return this.request("stop");
    },
    admission() {
      return this.request("admission", {}, { timeoutMs: 1500 });
    },
    // 屏幕接管：运行时只能请求与读取结论，批准只属于拥有会话的 UI。
    requestTakeover(owner) {
      return this.request("request_takeover", owner, { timeoutMs: 1500 });
    },
    // 返回 ProtectedForegroundGrant 视图：{ state, grantId?, expiresAt?, expired? }。
    takeoverStatus(owner) {
      return this.request("takeover_status", owner, { timeoutMs: 1500 });
    },
    // Helper 恢复只经 services 的既有生命周期所有者；运行时无法自行拉起 Helper。
    recoverHelper() {
      return this.request("recover_helper", {}, { timeoutMs: 10_000 });
    },
    reportActivity(report) {
      return this.request("report_activity", report, { timeoutMs: 1500 });
    },
  };
}

export { tokenMatches };
