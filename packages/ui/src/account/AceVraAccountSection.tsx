import { Button } from "@/components/ui/button.js";
import { useAccountEngineeringTools } from "@/hooks/useAccountEngineeringTools.js";
import { describeAccountStatus } from "./accountStatus.js";
import { AceVraDevicesSection } from "./AceVraDevicesSection.js";
import { AceVraTasksSection } from "./AceVraTasksSection.js";
import { useAccountText } from "./useAccountText.js";
import { useAceVraAccount } from "./useAceVraAccount.js";

/** Settings surface. Distinct from Model Providers: signing out here never touches them. */
export function AceVraAccountSection() {
  const { available, view, signIn, signOut, refresh } = useAceVraAccount();
  const engineeringTools = useAccountEngineeringTools();
  const text = useAccountText();
  const profile = view?.profile;
  const name = profile?.displayName?.trim() || text("unnamed", "AceVra account");
  return (
    <section className="space-y-4" data-testid="acevra-account-section">
      <div>
        <h2 className="text-ui-lg font-semibold text-foreground">
          {text("title", "AceVra Account")}
        </h2>
        <p className="text-ui-base text-foreground-subtle">
          {text(
            "description",
            "Your AceVra identity. Model providers are configured separately under Model settings.",
          )}
        </p>
      </div>
      {!available || !view ? (
        <p className="text-ui-base text-foreground-subtle">
          {text("desktopOnly", "AceVra Account is available in the desktop app.")}
        </p>
      ) : !view.configured ? (
        <p
          className="text-ui-base text-foreground-subtle"
          data-testid="acevra-account-unconfigured"
        >
          {text(
            "notConfigured",
            "Account sign-in isn't set up in this build. Everything else works locally.",
          )}
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            {profile && (
              <div className="flex min-w-0 items-center gap-3" data-testid="acevra-account-profile">
                <span
                  aria-hidden
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted font-medium"
                >
                  {name.slice(0, 1).toUpperCase()}
                </span>
                <span className="truncate text-ui-base font-medium">{name}</span>
              </div>
            )}
            <p
              className="min-w-0 flex-1 text-ui-base text-foreground-subtle"
              data-testid="acevra-account-status"
            >
              {describeAccountStatus(view, text)}
            </p>
            <div className="flex gap-2">
              {view.phase === "ready" ? (
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="acevra-account-signout"
                  onClick={() => void signOut()}
                >
                  {text("signOut", "Sign out")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  data-testid="acevra-account-settings-signin"
                  onClick={() => void signIn()}
                >
                  {text("signInTitle", "Sign in to AceVra")}
                </Button>
              )}
              {(view.phase === "offline" || view.phase === "denied") && (
                <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                  {text("retry", "Try again")}
                </Button>
              )}
            </div>
          </div>
          {view.phase === "ready" && <AceVraDevicesSection />}
          {view.phase === "ready" && view.rememberSession === false && (
            <p
              className="text-ui-sm text-foreground-subtle"
              data-testid="acevra-account-not-remembered"
            >
              {text("notRemembered", "Account session won't be remembered on this device.")}
            </p>
          )}
          {view.phase === "ready" && (
            <p className="text-ui-sm text-foreground-subtle">
              {text(
                "signOutNote",
                "Signing out keeps your local conversations and model providers.",
              )}
            </p>
          )}
        </div>
      )}
      {/* 工程 runner 只在显式开启且未打包时出现；正常账号页不承载手动执行表单。 */}
      {available && view && engineeringTools && <AceVraTasksSection />}
    </section>
  );
}
