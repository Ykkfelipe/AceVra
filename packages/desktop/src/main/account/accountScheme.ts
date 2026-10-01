import { ACCOUNT_RENDERER_SCHEME } from "@zcode/shared";
import {
  registerLocalMediaPreviewScheme,
  type LocalMediaPreviewSchemeRegistrar,
} from "../localMediaPreviewProtocol.js";

/** Same privileges the Clerk bridge requests for its renderer scheme. */
export const ACCOUNT_SCHEME: Electron.CustomScheme = {
  scheme: ACCOUNT_RENDERER_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
};

/**
 * registerSchemesAsPrivileged REPLACES earlier registrations (verified on Electron 41:
 * a second call dropped the first call's `secure` privilege). `createClerkBridge`
 * registers the account scheme itself, so this must run AFTER it and declare every
 * privileged scheme in one call.
 */
export function registerPrivilegedSchemes(
  registrar: LocalMediaPreviewSchemeRegistrar,
  options: { accountEnabled: boolean },
): void {
  registerLocalMediaPreviewScheme(registrar, options.accountEnabled ? [ACCOUNT_SCHEME] : []);
}
