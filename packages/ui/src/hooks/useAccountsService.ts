import type { IAccountsService } from "@zcode/services";
import { useResolvedServiceAccessor } from "@/hooks/useWorkspaceServices.js";

/**
 * Accounts & Imports service.
 *
 * Returns sanitized account/usage state only; no credential material can cross this
 * boundary. Host-side adapters are the only components that touch the local Codex,
 * Claude Code and Command Code clients.
 */
export function useAccountsService(): IAccountsService {
  return useResolvedServiceAccessor(undefined, undefined, undefined).accountsService;
}
