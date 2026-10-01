/**
 * Clerk session persistence facts, kept free of any Clerk/electron-store import so code that
 * only needs to READ them never loads the account dependency graph.
 */

/** electron-store file (under userData) holding Clerk's OS-encrypted tokens. */
export const ACCOUNT_TOKEN_STORE_NAME = "acevra-account-tokens";

let sessionPersistent = false;
/** Whether this launch persists the Clerk session (set when the bridge is created). */
export const isAccountSessionPersistent = () => sessionPersistent;
export const setAccountSessionPersistent = (value: boolean) => {
  sessionPersistent = value;
};
