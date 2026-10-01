import { useCallback, useEffect, useState } from "react";
import type { AccountView } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";

/**
 * Account projection from the platform. Never reads provider state: AceVra Account
 * and Model Providers are independent. `view === null` until the first read resolves,
 * and permanently when the platform has no account feature (Web).
 */
export function useAceVraAccount() {
  const account = useOptionalPlatform()?.account;
  const [view, setView] = useState<AccountView | null>(null);

  useEffect(() => {
    if (!account) return;
    let active = true;
    // Subscribe first so a change racing the initial read is not lost.
    const off = account.onViewChanged((next) => active && setView(next));
    account
      .getView()
      .then((next) => active && setView((current) => current ?? next))
      .catch(() => undefined);
    return () => {
      active = false;
      off();
    };
  }, [account]);

  return {
    available: Boolean(account),
    view,
    signIn: useCallback(() => account?.signIn() ?? Promise.resolve(), [account]),
    signOut: useCallback(() => account?.signOut() ?? Promise.resolve(), [account]),
    refresh: useCallback(() => account?.refresh() ?? Promise.resolve(), [account]),
    chooseLocal: useCallback(() => account?.chooseLocal() ?? Promise.resolve(), [account]),
  };
}

/**
 * The account choice is a startup step: shown while the choice is undecided and the
 * account is not admitted, and never again this session once the user got through it
 * (admitted or chose local). A later sign-out must not yank the user out of the shell.
 */
export function useAccountChoiceGate(view: AccountView | null): boolean {
  const [passed, setPassed] = useState(false);
  const through = Boolean(view && (view.phase === "ready" || view.choice === "local"));
  useEffect(() => {
    if (through) setPassed(true);
  }, [through]);
  return Boolean(view?.configured && view.choice === "undecided" && !through && !passed);
}
