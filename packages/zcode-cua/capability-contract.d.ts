export type ComputerUseMethod =
  | "permission_status"
  | "list_apps"
  | "list_windows"
  | "observe"
  | "control_status"
  | "press"
  | "set_value"
  | "acquire_control"
  | "release_control"
  | "activate_target"
  | "move_pointer"
  | "click"
  | "type_text"
  | "key_press"
  | "scroll"
  | "drag";
export type ComputerUseEffect = "confirmed" | "partial" | "unknown" | "refused" | "failed";
export type ComputerUseClassification =
  | "BACKGROUND_SAFE"
  | "BEST_EFFORT_BACKGROUND"
  | "REQUIRES_FOREGROUND"
  | "UNSUPPORTED";
export declare const COMPUTER_USE_METHODS: Readonly<
  Record<ComputerUseMethod, "read" | "mutation" | "control" | "foreground">
>;
export declare const COMPUTER_USE_MODEL_TO_METHOD: Readonly<Record<string, ComputerUseMethod>>;
export declare const COMPUTER_USE_BACKEND_SUPPORT: Readonly<Record<string, boolean>>;
export declare const COMPUTER_USE_CANONICAL_MODEL_PREFIX: "mcp__computer-use__";
export declare function canonicalComputerUseMcpName(modelVisibleToolName: string): string;
export declare const COMPUTER_USE_CLASSIFICATIONS: readonly ComputerUseClassification[];
export declare const COMPUTER_USE_EFFECTS: readonly ComputerUseEffect[];
export declare const COMPUTER_USE_ROUTES: readonly (
  | "accessibility_action"
  | "quartz_input"
  | "none"
)[];
export declare const COMPUTER_USE_ACTION_CLASSIFICATIONS: Readonly<
  Record<"press" | "set_value", "BEST_EFFORT_BACKGROUND"> &
    Record<
      | "acquire_control"
      | "release_control"
      | "activate_target"
      | "move_pointer"
      | "click"
      | "type_text"
      | "key_press"
      | "scroll"
      | "drag",
      "REQUIRES_FOREGROUND"
    >
>;
export declare const COMPUTER_USE_FOREGROUND_METHODS: readonly ComputerUseMethod[];
export declare const COMPUTER_USE_MODEL_GUIDANCE: string;
export declare function normalizeComputerUseResult(
  value: unknown,
  expectedMethod?: ComputerUseMethod,
): Record<string, unknown> & {
  effect: ComputerUseEffect;
  route: string;
  evidence: unknown[];
};
export declare function validSemanticActionInput(method: string, input: unknown): boolean;
export declare function validForegroundInput(method: string, input: unknown): boolean;
export declare function resolveComputerUseMethod(
  modelToolName: string,
): ComputerUseMethod | undefined;
export declare function resolveComputerUseCapabilities(input: {
  platform: string;
  helperVerified: boolean;
  accessibility: string;
}): Record<string, boolean | "probe_required">;
