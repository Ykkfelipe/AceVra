import type { ComponentProps } from "react";
import type { SignIn } from "@clerk/electron/react";

/**
 * Derived from `SignIn`'s own props rather than imported from a Clerk internal path,
 * so the theme keys are checked against the installed Clerk version.
 */
export type AceVraClerkAppearance = NonNullable<ComponentProps<typeof SignIn>["appearance"]>;

/**
 * AceVra theming for Clerk's hosted components.
 *
 * This is presentation only. Clerk remains the authentication authority: it decides
 * which sign-in methods to render, and M1 never hand-draws a provider button, because
 * doing so would mean guessing the instance configuration and could advertise a
 * provider that is not enabled.
 *
 * Every color references the custom properties declared in `./account.css`, so one
 * theme switch on the root element restyles the AceVra shell and Clerk's components
 * together instead of keeping two color sources in sync by hand.
 */
export const acevraClerkAppearance: AceVraClerkAppearance = {
  // `simple` is the low-chrome base theme; the shell supplies the card, wordmark and
  // layout, so Clerk only has to style the form it owns.
  theme: "simple",
  options: {
    // The window already renders the AceVra wordmark above the form.
    logoPlacement: "none",
  },
  variables: {
    colorPrimary: "var(--acevra-primary)",
    colorPrimaryForeground: "var(--acevra-primary-foreground)",
    colorBackground: "var(--acevra-background)",
    colorForeground: "var(--acevra-foreground)",
    colorMutedForeground: "var(--acevra-foreground-subtle)",
    colorInput: "var(--acevra-border-strong)",
    colorInputForeground: "var(--acevra-foreground)",
    colorBorder: "var(--acevra-border)",
    colorDanger: "var(--acevra-destructive)",
    colorRing: "var(--acevra-focus-ring)",
    colorModalBackdrop: "color-mix(in oklab, var(--acevra-background) 72%, transparent)",
    fontFamily: "inherit",
    fontSize: "14px",
    borderRadius: "8px",
  },
  elements: {
    // The AceVra shell owns the page and card surfaces; Clerk stays transparent so the
    // two never stack two backgrounds on top of each other.
    rootBox: {
      backgroundColor: "transparent",
      boxShadow: "none",
    },
    cardBox: {
      backgroundColor: "transparent",
      boxShadow: "none",
      border: "none",
      padding: "0",
      width: "100%",
    },
    card: {
      backgroundColor: "transparent",
      boxShadow: "none",
      border: "none",
      padding: "0",
    },
    headerTitle: {
      fontSize: "16px",
      fontWeight: "600",
      color: "var(--acevra-foreground)",
    },
    headerSubtitle: {
      fontSize: "13px",
      fontWeight: "400",
      color: "var(--acevra-foreground-subtle)",
    },
    socialButtonsBlockButton: {
      backgroundColor: "var(--acevra-background)",
      color: "var(--acevra-foreground)",
      borderColor: "var(--acevra-border-strong)",
      fontSize: "14px",
      fontWeight: "500",
      boxShadow: "none",
    },
    socialButtonsBlockButtonHover: {
      backgroundColor: "var(--acevra-surface-sunken)",
    },
    formButtonPrimary: {
      backgroundColor: "var(--acevra-primary)",
      color: "var(--acevra-primary-foreground)",
      fontSize: "14px",
      fontWeight: "500",
      boxShadow: "none",
    },
    formFieldInput: {
      backgroundColor: "var(--acevra-background)",
      color: "var(--acevra-foreground)",
      borderColor: "var(--acevra-border-strong)",
      fontSize: "14px",
      boxShadow: "none",
    },
    formFieldInputFocus: {
      borderColor: "var(--acevra-focus-ring)",
      boxShadow: "none",
    },
    formFieldLabel: {
      color: "var(--acevra-foreground-subtle)",
      fontSize: "13px",
    },
    formFieldErrorText: {
      color: "var(--acevra-destructive)",
    },
    footerAction: {
      color: "var(--acevra-foreground-subtle)",
      fontSize: "13px",
    },
    footerActionLink: {
      color: "var(--acevra-foreground)",
      fontWeight: "500",
    },
    dividerLine: {
      backgroundColor: "var(--acevra-border)",
    },
    dividerText: {
      color: "var(--acevra-foreground-subtlest)",
      fontSize: "12px",
    },
    alertBox: {
      backgroundColor: "var(--acevra-background)",
      color: "var(--acevra-destructive)",
    },
    alertBoxIcon: {
      color: "var(--acevra-destructive)",
    },
  },
};
