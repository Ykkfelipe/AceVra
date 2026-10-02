export type ComputerUseSurfaceKind = "read" | "background" | "foreground";
export interface ComputerUseSurfaceEntry {
  readonly name: string;
  readonly kind: ComputerUseSurfaceKind;
  readonly args: string;
  readonly returns?: string;
  readonly note?: string;
}
export declare const COMPUTER_USE_SURFACE: readonly ComputerUseSurfaceEntry[];
export declare const COMPUTER_USE_LIMITS: readonly string[];
export declare const COMPUTER_USE_COMPAT_ALIASES: Readonly<Record<string, string>>;
export declare function canonicalComputerUseName(modelToolName: string): string;
export declare function computerUseArgsHint(modelToolName: string): string | undefined;
export declare function describeComputerUseSurface(input: {
  platform: string;
  foregroundAvailable: boolean;
}): { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown> };
export declare const MODEL_TOOL_HINT: string;
export declare function argsRefusal(toolName: string, method: string): string;
export declare function foregroundComputerUseAvailable(
  context:
    | {
        runtimeScope?: string;
        clientMode?: string;
        deliveryKind?: string;
        remoteSessionId?: string;
      }
    | undefined,
  allowForegroundControl: (() => boolean) | undefined,
): boolean;

export declare function resolveComputerUseDeliveryContext(
  context:
    | {
        clientMode?: string;
        deliveryKind?: string;
      }
    | undefined,
): { clientMode: string; deliveryKind: string };
