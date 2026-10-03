import { Button } from "@/components/ui/button.js";
import { describeAccountStatus } from "./accountStatus.js";
import { useAccountText } from "./useAccountText.js";
import { useAceVraAccount } from "./useAceVraAccount.js";

/**
 * Optional account step shown once after provider setup. "Continue locally" is always
 * available and never depends on Clerk or the backend being reachable.
 */
export function AceVraAccountChoice() {
  const { view, signIn, refresh, chooseLocal } = useAceVraAccount();
  const text = useAccountText();
  if (!view) return null;
  const waiting = ["authenticating", "authenticated", "admissionChecking"].includes(view.phase);
  const showStatus = view.phase !== "signedOut" || view.detail !== undefined;
  // A revoked admission never resolves on its own, so it needs an explicit way back in
  // rather than leaving the user on a button that will keep failing.
  const denied = view.phase === "denied";
  return (
    <main
      className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground"
      data-testid="acevra-account-choice"
    >
      <section className="w-full max-w-md space-y-6">
        <header className="space-y-2">
          <h1 className="text-ui-xl font-semibold">{text("welcome", "Welcome to AceVra")}</h1>
          <p className="text-ui-base text-foreground-subtle">
            {text(
              "subtitle",
              "Sign in to connect your AceVra account. Conversation and device sync is coming later.",
            )}
          </p>
        </header>
        <div className="space-y-3">
          {/* The control stays mounted even in an unconfigured build: it opens the Account
              window, which explains that sign-in is unavailable rather than failing
              silently. Removing it here would strand the user with no explanation. */}
          <Button
            className="w-full"
            disabled={waiting}
            data-testid="acevra-account-signin"
            onClick={() => void signIn()}
          >
            {text("signIn", "Sign in to AceVra")}
          </Button>
          {!view.configured && (
            <p role="status" className="text-ui-sm text-foreground-subtle">
              {text(
                "notConfiguredChoice",
                "Account sign-in isn't available in this build. You can keep using AceVra locally.",
              )}
            </p>
          )}
          {(view.phase === "offline" || denied) && (
            <Button
              variant="outline"
              className="w-full"
              data-testid="acevra-account-retry"
              onClick={() => void refresh()}
            >
              {text("retry", "Try again")}
            </Button>
          )}
          <Button
            variant="ghost"
            className="w-full"
            data-testid="acevra-account-local"
            onClick={() => void chooseLocal()}
          >
            {text("continueLocally", "Continue locally")}
          </Button>
        </div>
        {showStatus && (
          <p
            role="status"
            className="text-ui-sm text-foreground-subtle"
            data-testid="acevra-account-status"
          >
            {describeAccountStatus(view, text)}
          </p>
        )}
        {/* Two boundaries that social sign-in must not blur: signing in identifies the
            account without connecting any external service, and trusting a computer is a
            separate step that happens after sign-in. */}
        <footer className="space-y-1 border-t border-card-border pt-4">
          <p className="text-ui-sm text-foreground-subtlest">
            {text(
              "dataBoundary",
              "Signing in connects your AceVra account only. It doesn't give AceVra access to your email, calendar or code.",
            )}
          </p>
          <p className="text-ui-sm text-foreground-subtlest">
            {text("deviceBoundary", "Trusted computers are added separately, after you sign in.")}
          </p>
        </footer>
      </section>
    </main>
  );
}
