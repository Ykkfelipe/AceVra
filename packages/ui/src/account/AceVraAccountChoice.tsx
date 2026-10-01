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
  return (
    <main
      className="flex min-h-screen items-center justify-center bg-background p-6"
      data-testid="acevra-account-choice"
    >
      <section className="w-full max-w-md space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold">{text("welcome", "Welcome to AceVra")}</h1>
          <p className="text-muted-foreground">
            {text(
              "subtitle",
              "Sign in to connect your AceVra account. Conversation and device sync is coming later.",
            )}
          </p>
        </header>
        <div className="space-y-3">
          <Button
            className="w-full"
            disabled={waiting}
            data-testid="acevra-account-signin"
            onClick={() => void signIn()}
          >
            {text("signIn", "Continue with Google or email")}
          </Button>
          {view.phase === "offline" && (
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
            className="text-sm text-muted-foreground"
            data-testid="acevra-account-status"
          >
            {describeAccountStatus(view, text)}
          </p>
        )}
      </section>
    </main>
  );
}
