import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { ACCOUNT_RENDERER_HOST, ACCOUNT_RENDERER_SCHEME } from "@zcode/shared";
import { clerkFrontendHost } from "./accountConfig.js";

const ENTRY = "account.html";

/**
 * Maps an `acevra-account://renderer/...` URL to a bundled file. Only the account
 * entry and its `assets/` are servable; traversal, other hosts and other renderer
 * pages (including the main app) resolve to null.
 */
export function resolveAccountAsset(rawUrl: string, rendererDir: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${ACCOUNT_RENDERER_SCHEME}:` || url.host !== ACCOUNT_RENDERER_HOST) {
    return null;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0") || pathname.includes("\\")) return null;
  const requested = pathname === "/" ? `/${ENTRY}` : pathname;
  const target = normalize(join(rendererDir, requested));
  const rel = relative(rendererDir, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const first = rel.split(sep)[0];
  return rel === ENTRY || first === "assets" ? target : null;
}

/** CSP per the official Clerk Electron guide; no `unsafe-eval`, no dev origins. */
export function buildAccountCsp(publishableKey: string): string {
  const fapi = clerkFrontendHost(publishableKey);
  const host = fapi ? ` https://${fapi}` : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${host} https://challenges.cloudflare.com https://*.protect.clerk.com`,
    `connect-src 'self'${host} https://*.protect.clerk.com:* https://clerk-telemetry.com`,
    "img-src 'self' https://img.clerk.com data:",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    "frame-src 'self' https://challenges.cloudflare.com https://*.protect.clerk.com",
    "form-action 'self'",
  ].join("; ");
}
