import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider, SignIn, useAuth } from "@clerk/electron/react";
import { acevraClerkAppearance } from "./acevraClerkAppearance.js";
import "./account.css";

interface AccountWindowBridge {
  getConfig(): Promise<{ publishableKey: string }>;
  reportSession(signedIn: boolean): void;
  onRequest(handler: (kind: "getToken" | "signOut") => Promise<unknown>): () => void;
}
const bridge = (window as unknown as { acevraAccountWindow: AccountWindowBridge })
  .acevraAccountWindow;

/**
 * Signing in identifies the account. It is not a grant: no external service is
 * connected and no data is shared by signing in. Devices are trusted separately,
 * by registering or pairing a computer after sign-in.
 */
const DATA_BOUNDARY_NOTE =
  "Signing in connects your AceVra account only. It does not give AceVra access to your email, calendar or code. Trusted computers are added separately.";

/** Mirrors the Clerk session to main and answers its per-request token/sign-out asks. */
function SessionBridge() {
  const { isLoaded, isSignedIn, getToken, signOut } = useAuth();
  useEffect(() => {
    if (isLoaded) bridge.reportSession(Boolean(isSignedIn));
  }, [isLoaded, isSignedIn]);
  useEffect(
    () =>
      bridge.onRequest(async (kind) => {
        if (kind === "signOut") {
          await signOut();
          return true;
        }
        // Fresh token per backend request; Clerk session JWTs are short-lived.
        return (await getToken({ skipCache: true })) ?? null;
      }),
    [getToken, signOut],
  );
  if (!isLoaded) return <StatusNote>Loading…</StatusNote>;
  if (isSignedIn) {
    return <p className="acevra-account__note">Signed in. You can close this window.</p>;
  }
  return <SignIn routing="hash" appearance={acevraClerkAppearance} />;
}

function StatusNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="acevra-account__status" role="status" aria-busy="true">
      <span className="acevra-account__spinner" aria-hidden="true" />
      {children}
    </p>
  );
}

function Brand() {
  return (
    <div className="acevra-account__brand">
      <span className="acevra-account__wordmark">AceVra</span>
    </div>
  );
}

/**
 * The window owns presentation and state only. Token issuance, keychain persistence
 * and admission stay behind the preload bridge; this renderer never sees a secret.
 */
function App() {
  const [config, setConfig] = useState<{ publishableKey: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(() => {
    let active = true;
    setFailed(false);
    setConfig(null);
    bridge
      .getConfig()
      .then((next) => {
        if (active) setConfig(next);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => load(), [load, attempt]);

  const heading = (
    <>
      <Brand />
      <div>
        <h1 className="acevra-account__title">Sign in to AceVra</h1>
        <p className="acevra-account__subtitle">
          Your account connects conversations and the computers you trust.
        </p>
      </div>
    </>
  );

  if (failed) {
    return (
      <main className="acevra-account">
        <section className="acevra-account__card">
          {heading}
          <p className="acevra-account__error" role="alert">
            Account sign-in is unavailable right now.
          </p>
          <button
            className="acevra-account__button"
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </button>
          <p className="acevra-account__note">{DATA_BOUNDARY_NOTE}</p>
        </section>
      </main>
    );
  }

  // An empty publishable key is a build without Clerk configured. Render an explicit
  // state: the previous shell showed a sign-in control that silently did nothing.
  if (config && !config.publishableKey.trim()) {
    return (
      <main className="acevra-account">
        <section className="acevra-account__card">
          {heading}
          <p className="acevra-account__error" role="alert">
            Account sign-in is not configured in this build. You can keep using AceVra locally.
          </p>
          <p className="acevra-account__note">{DATA_BOUNDARY_NOTE}</p>
        </section>
      </main>
    );
  }

  if (!config) {
    return (
      <main className="acevra-account">
        <section className="acevra-account__card">
          {heading}
          <StatusNote>Preparing sign-in…</StatusNote>
        </section>
      </main>
    );
  }

  return (
    <ClerkProvider publishableKey={config.publishableKey}>
      <main className="acevra-account">
        <section className="acevra-account__card">
          {heading}
          <SessionBridge />
          <p className="acevra-account__note">{DATA_BOUNDARY_NOTE}</p>
        </section>
      </main>
    </ClerkProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
