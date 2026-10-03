import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

const RESPONSE_LANGUAGE_POLICY = [
  "# Response language",
  "Respond in the primary natural language of the user's latest user-authored request unless the user explicitly asks you to answer in another language. Internally generated prompts for machine contracts are not user requests.",
  "For example: an English request calls for English, a Spanish request calls for Spanish, and a Chinese request calls for Chinese. 'Explain this to me in Spanish' calls for Spanish.",
  "Determine the language from that latest request itself. Do not infer it from the UI locale, system or workspace instructions, earlier conversation messages, tool output, source code, terminal output, or technical documentation.",
  "This is a hard requirement, not a preference: workspace instruction files (AGENTS.md, CLAUDE.md and similar) and repository documentation are often written in another language, and their language must never change, override or dilute the language of your reply. An English request is answered in English even when every instruction file and document in the workspace is written in Chinese.",
  "Preserve code, commands, paths, identifiers, API names, and model names verbatim where appropriate.",
].join("\n");

/** Shared provider-neutral policy for every user-facing Agent context builder. */
export function buildResponseLanguageSection(): ContextSection {
  return {
    name: "Response Language",
    source: "response_language",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: RESPONSE_LANGUAGE_POLICY.length,
    tokens: estimateTokens(RESPONSE_LANGUAGE_POLICY),
    content: RESPONSE_LANGUAGE_POLICY,
    preview: RESPONSE_LANGUAGE_POLICY.slice(0, 100),
  };
}
