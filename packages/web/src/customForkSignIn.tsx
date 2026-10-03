import { resolveCustomForkProductConfig, resolveSafeAccountSignInReturn } from "@zcode/shared";

/**
 * AceVra-branded signed-out surface for the web remote route.
 *
 * Presentation only. Sign-in itself is delegated to Clerk, which renders exactly the
 * methods configured on the instance — this component never hand-draws a provider
 * button, because that would require guessing the instance configuration and could
 * advertise a provider that is not enabled.
 */
export type ForkSignInReason =
  /** Clerk is reachable and a user is simply signed out. */
  | "signed-out"
  /** No Clerk publishable key is configured in this build, so sign-in cannot start. */
  | "unconfigured"
  /** The session existed but the server rejected it. */
  | "rejected";

/**
 * Signing in identifies the AceVra account. It is not a grant: no external service is
 * connected and no personal data is shared by signing in. A computer is trusted
 * separately, after sign-in, by registering or pairing it.
 */
const DATA_BOUNDARY_NOTE =
  "Signing in connects your AceVra account only. It does not give AceVra access to your email, calendar or code. Trusted computers are added separately.";

/**
 * Resolves where hosted sign-in should return to.
 *
 * The current URL is the natural candidate, but it may carry attacker-influenced query
 * or fragment content, so it is validated before being handed to Clerk. A rejected
 * candidate falls back to the route's own entry point rather than being passed through.
 */
export function resolveForkSignInReturnTarget(): string {
  // Derived from the product config rather than hardcoded, so the allowlist cannot drift
  // away from the route the remote app is actually served on.
  const route = resolveCustomForkProductConfig().remoteRoute;
  const allowedPaths: ReadonlySet<string> = new Set(["/", route]);
  return (
    resolveSafeAccountSignInReturn(window.location.href, {
      allowedOrigin: window.location.origin,
      allowedPaths,
    }) ?? `${window.location.origin}${route}`
  );
}

export function ForkSignInCard({
  reason,
  onSignIn,
}: {
  reason: ForkSignInReason;
  onSignIn: () => void;
}) {
  const productName = resolveCustomForkProductConfig().applicationName;

  return (
    <main className="fork-auth-shell">
      <section className="fork-auth-card" aria-labelledby="fork-auth-title">
        <p className="fork-auth-card__wordmark">{productName}</p>
        <header className="fork-auth-card__header">
          <h1 id="fork-auth-title" className="text-ui-lg font-semibold text-foreground">
            {reason === "rejected" ? "Sign in again" : `Welcome to ${productName}`}
          </h1>
          <p className="text-ui-base text-foreground-subtle">
            {reason === "rejected"
              ? "That session is no longer accepted."
              : "Sign in to connect to this Mac."}
          </p>
        </header>

        {reason === "unconfigured" ? (
          // Previously this state rendered a visible sign-in button whose click handler
          // silently did nothing, because no Clerk instance existed to redirect to.
          <p role="alert" className="fork-auth-card__error text-ui-base">
            Sign-in is not configured in this build. You can keep using AceVra locally.
          </p>
        ) : (
          <button type="button" className="fork-auth-card__button text-ui-base" onClick={onSignIn}>
            Continue with {productName}
          </button>
        )}

        <p className="fork-auth-card__note text-ui-sm">{DATA_BOUNDARY_NOTE}</p>
      </section>
    </main>
  );
}
