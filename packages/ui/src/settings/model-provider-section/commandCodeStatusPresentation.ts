import type { CommandCodeStatus } from "@zcode/services";

export interface CommandCodeCliMetadata {
  defaultModel?: string;
  contextWindow?: string;
}

/** Keep supported CLI metadata compact and omit fields the CLI did not report. */
export function resolveCommandCodeCliMetadata(
  status: CommandCodeStatus | null | undefined,
  locale: string,
): CommandCodeCliMetadata {
  return {
    ...(status?.defaultModel ? { defaultModel: status.defaultModel } : {}),
    ...(status?.contextWindow
      ? { contextWindow: status.contextWindow.toLocaleString(locale) }
      : {}),
  };
}
