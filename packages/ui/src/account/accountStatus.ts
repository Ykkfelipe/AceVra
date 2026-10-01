import type { AccountView } from "@zcode/shared";

/** Plain-language status for each projection state; never implies sync exists. */
export function describeAccountStatus(
  view: AccountView,
  text: (id: string, fallback: string) => string,
): string {
  switch (view.phase) {
    case "authenticating":
      return text("status.authenticating", "Waiting for sign-in to finish…");
    case "authenticated":
    case "admissionChecking":
      return text("status.checking", "Checking your private-alpha access…");
    case "ready":
      return text("status.ready", "Connected · private alpha");
    case "denied":
      return text(
        "status.denied",
        "This account isn't part of the private alpha yet. You can keep using AceVra locally.",
      );
    case "offline":
      return text(
        "status.offline",
        "AceVra Account is unreachable right now. Local features are unaffected.",
      );
    default:
      return view.detail === "session_rejected"
        ? text("status.rejected", "Your sign-in was not accepted. Please sign in again.")
        : text("status.signedOut", "Not signed in");
  }
}
