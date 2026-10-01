import type { AccountDeviceCapability } from "@zcode/shared";

/**
 * What this desktop truthfully offers, derived from services that are actually wired:
 * - files / shell: the Host registers IFileService and ITerminalService (createLocalServices).
 * - git: IGitService is registered but shells out to a git binary, so it needs one.
 * - computerUse: only on an OS the Computer Use runtime supports.
 * Descriptive facts only; never an authorization input.
 */
export function deriveDesktopCapabilities(facts: {
  gitAvailable: boolean;
  computerUseSupported: boolean;
}): AccountDeviceCapability[] {
  return [
    "files",
    "shell",
    ...(facts.gitAvailable ? (["git"] as const) : []),
    ...(facts.computerUseSupported ? (["computerUse"] as const) : []),
  ];
}
