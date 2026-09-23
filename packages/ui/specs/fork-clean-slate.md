# Fork clean-slate product direction

## Product rules

- The fork is its own desktop application named AceVra. Its app name, installer identity, and
  window title must not be confused with the installed original ZCode app.
- Keep the existing `zcode://oauth/callback` protocol because provider OAuth configuration
  depends on that callback URI; changing it requires provider-side registration first.
- Keep provider sign-in, model configuration, account state, usage/quota visibility, and the
  runtime paths needed to use an already-connected account.
- Remove in-app purchase, subscribe, upgrade, renewal, and billing-management entry points for
  Z.ai / Coding Plan / Start Plan. The fork must not route users to the original product's
  checkout or plan-management UI.
- When a capability requires a plan the account does not have, explain the requirement without
  attaching an upgrade action. Catalog/network errors keep their retry action when it only
  retries status data.
- Keep billing and entitlement service contracts intact during this UI cleanup. Removing a
  sales surface must not log users out, delete saved credentials, or disable models that their
  current account can already use.

## Acceptance scenarios

1. An already-connected Z.ai account remains connected, its models remain selectable, and
   reported usage remains visible after the purchase UI is removed.
2. Model Settings contains no subscribe, upgrade, renew, or Manage purchase link. Optional
   plan-catalog retry stays available and stays subtle when that lookup fails.
3. Chat context balance and Automation capability messages do not open checkout or upgrade
   flows. Existing usage/reset controls and truthful plan requirements remain usable.
4. A signed-out user can still connect a provider and configure a model without entering a
   purchase flow.
5. The fork identifies as AceVra in the app title and packaging identity.
