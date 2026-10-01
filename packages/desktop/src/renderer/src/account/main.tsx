import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider, SignIn, useAuth } from "@clerk/electron/react";

interface AccountWindowBridge {
  getConfig(): Promise<{ publishableKey: string }>;
  reportSession(signedIn: boolean): void;
  onRequest(handler: (kind: "getToken" | "signOut") => Promise<unknown>): () => void;
}
const bridge = (window as unknown as { acevraAccountWindow: AccountWindowBridge })
  .acevraAccountWindow;

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
  if (!isLoaded) return <p style={styles.note}>Loading…</p>;
  if (isSignedIn) return <p style={styles.note}>Signed in. You can close this window.</p>;
  return <SignIn routing="hash" />;
}

function App() {
  const [key, setKey] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    bridge
      .getConfig()
      .then((config) => setKey(config.publishableKey))
      .catch(() => setFailed(true));
  }, []);
  if (failed) return <p style={styles.note}>Account sign-in is unavailable.</p>;
  if (!key) return <p style={styles.note}>Loading…</p>;
  return (
    <ClerkProvider publishableKey={key}>
      <main style={styles.main}>
        <h1 style={styles.title}>AceVra Account</h1>
        <SessionBridge />
      </main>
    </ClerkProvider>
  );
}

const styles = {
  main: { display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: 24 },
  title: { font: "600 18px system-ui, sans-serif", margin: 0 },
  note: { font: "14px system-ui, sans-serif", color: "#666", textAlign: "center", padding: 24 },
} as const;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
