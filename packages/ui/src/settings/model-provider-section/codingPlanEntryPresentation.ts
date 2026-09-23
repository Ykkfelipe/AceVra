export type CodingPlanEntryStatus = "ready" | "loading" | "error";

export interface CodingPlanEntryPresentation {
  status: CodingPlanEntryStatus;
  quietFailure: boolean;
  disabled: boolean;
  activation: "run" | "retry" | "none";
  showChildren: boolean;
}

export function isCodingPlanActionDisabled(status: CodingPlanEntryStatus): boolean {
  return status !== "ready";
}

/** Resolve whether an entry runs its action, retries plan inventory, or stays disabled. */
export function resolveCodingPlanEntryPresentation(
  status: CodingPlanEntryStatus,
  options: { bypassGate?: boolean; quietError?: boolean } = {},
): CodingPlanEntryPresentation {
  const effectiveStatus = options.bypassGate ? "ready" : status;
  const quietFailure = options.quietError === true && effectiveStatus === "error";
  return {
    status: effectiveStatus,
    quietFailure,
    disabled: effectiveStatus === "loading" || quietFailure,
    activation:
      effectiveStatus === "ready" ? "run" : effectiveStatus === "error" ? "retry" : "none",
    showChildren: effectiveStatus === "ready" || quietFailure,
  };
}
