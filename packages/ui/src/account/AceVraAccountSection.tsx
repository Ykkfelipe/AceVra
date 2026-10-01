import { Button } from "@/components/ui/button.js";
import { describeAccountStatus } from "./accountStatus.js";
import { useAccountText } from "./useAccountText.js";
import { useAceVraAccount } from "./useAceVraAccount.js";

/** Settings surface. Distinct from Model Providers: signing out here never touches them. */
export function AceVraAccountSection() {
  const { available, view, signIn, signOut, refresh } = useAceVraAccount();
  const text = useAccountText();
  const profile = view?.profile;
  const name = profile?.displayName?.trim() || text("unnamed", "AceVra account");
  return (
    <section className="space-y-4" data-testid="acevra-account-section">
      <div>
        <h2 className="text-lg font-semibold">{text("title", "AceVra Account")}</h2>
        <p className="text-sm text-muted-foreground">
          {text(
            "description",
            "Your AceVra identity. Model providers are configured separately under Model settings.",
          )}
        </p>
      </div>
      {!available || !view ? (
        <p className="text-sm text-muted-foreground">
          {text("desktopOnly", "AceVra Account is available in the desktop app.")}
        </p>
      ) : !view.configured ? (
        <p className="text-sm text-muted-foreground" data-testid="acevra-account-unconfigured">
          {text(
            "notConfigured",
            "Account sign-in isn't set up in this build. Everything else works locally.",
          )}
        </p>
      ) : (
        <div className="space-y-3">
          {profile && (
            <div className="flex items-center gap-3" data-testid="acevra-account-profile">
              <span
                aria-hidden
                className="flex size-9 items-center justify-center rounded-full bg-muted font-medium"
              >
                {name.slice(0, 1).toUpperCase()}
              </span>
              <span className="font-medium">{name}</span>
            </div>
          )}
          <p className="text-sm" data-testid="acevra-account-status">
            {describeAccountStatus(view, text)}
          </p>
          <div className="flex gap-2">
            {view.phase === "ready" ? (
              <Button
                variant="outline"
                data-testid="acevra-account-signout"
                onClick={() => void signOut()}
              >
                {text("signOut", "Sign out")}
              </Button>
            ) : (
              <Button data-testid="acevra-account-settings-signin" onClick={() => void signIn()}>
                {text("signInTitle", "Sign in to AceVra")}
              </Button>
            )}
            {(view.phase === "offline" || view.phase === "denied") && (
              <Button variant="ghost" onClick={() => void refresh()}>
                {text("retry", "Try again")}
              </Button>
            )}
          </div>
          {view.phase === "ready" && view.rememberSession === false && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="acevra-account-not-remembered"
            >
              {text("notRemembered", "Account session won't be remembered on this device.")}
            </p>
          )}
          {view.phase === "ready" && (
            <p className="text-xs text-muted-foreground">
              {text(
                "signOutNote",
                "Signing out keeps your local conversations and model providers.",
              )}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
