const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const DEVICE_CHANNEL_PATH = "/v1/device-channel";

/**
 * Production traffic is https/wss. Plain http/ws is allowed only for loopback (local
 * development) or when ACEVRA_NODE_ALLOW_INSECURE=1 is set explicitly.
 */
export function resolveEndpoints(
  apiBase: string,
  env: NodeJS.ProcessEnv = process.env,
): { httpBase: string; wsUrl: string } {
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    throw new Error("Invalid control-plane URL");
  }
  const secure = url.protocol === "https:";
  if (!secure) {
    const insecureOk =
      url.protocol === "http:" &&
      (LOOPBACK.has(url.hostname) || env.ACEVRA_NODE_ALLOW_INSECURE === "1");
    if (!insecureOk)
      throw new Error(
        "The control plane must use https (http is allowed only for loopback development)",
      );
  }
  const ws = new URL(DEVICE_CHANNEL_PATH, url.origin);
  ws.protocol = secure ? "wss:" : "ws:";
  return { httpBase: url.origin, wsUrl: ws.toString() };
}
