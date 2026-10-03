/**
 * Post-sign-in destination validation.
 *
 * AceVra hands a return target to the hosted auth surface. That target can originate
 * from the current URL, which may carry attacker-influenced query or fragment content.
 * Passing it through unchecked would turn sign-in into an open redirect, so every
 * surface resolves its return target here first.
 *
 * This mirrors `resolveSafeAppReturnTo` in the web share flow: the caller owns the
 * path allowlist, this module owns the parsing and the same-origin rule.
 */

export interface SafeAccountSignInReturnOptions {
  /** Exact origin the candidate must match, e.g. `https://app.acevra.ai`. */
  allowedOrigin: string;
  /** Paths the surface may return to. Comparison is exact and case-sensitive. */
  allowedPaths: ReadonlySet<string>;
}

function parseOptionalUrl(value: string | undefined): URL | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // A protocol-relative value (`//evil.example`) resolves against the current
  // protocol, so reject the shape before URL parsing can normalize it away.
  if (!trimmed || trimmed.startsWith("//")) return null;
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

function parseOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Resolves a post-sign-in return target to an absolute same-origin URL, or `null`
 * when the candidate is not acceptable. `null` means "fall back to the surface's
 * default landing route" — callers must never fall back to the rejected input.
 *
 * Query and fragment are dropped: the allowed routes are entry points, and keeping
 * caller-supplied parameters would let an attacker smuggle state past validation.
 */
export function resolveSafeAccountSignInReturn(
  candidate: string | undefined,
  options: SafeAccountSignInReturnOptions,
): string | null {
  const allowedOrigin = parseOrigin(options.allowedOrigin);
  if (!allowedOrigin) return null;

  const url = parseOptionalUrl(candidate);
  if (!url) return null;

  // Embedded credentials turn a same-origin URL into a phishable one.
  if (url.username || url.password) return null;
  if (url.origin !== allowedOrigin) return null;
  if (!options.allowedPaths.has(url.pathname)) return null;

  return `${allowedOrigin}${url.pathname}`;
}
