/**
 * ESM loader stub: maps Vite-style image imports (`.svg`, `.png`, …) to an empty default
 * export.
 *
 * Why this exists: `chat-input-toolbar/thoughtLevelOptions.ts` imports
 * `chat-input-toolbar/display.tsx`, whose transitive React import graph reaches
 * `settings/model-provider-section/ProviderLogo.tsx` and therefore real image files. Vite
 * resolves those at build time; plain `node --import tsx` cannot, so importing the label
 * table under `node:test` fails with ERR_UNKNOWN_FILE_EXTENSION. Registering this stub keeps
 * the value under test (the label table) real — only asset bytes are faked.
 *
 * Used by packages/ui/test/providerManagedThoughtOption.test.ts via `module.register`.
 */
const ASSET_PATTERN = /\.(?:svg|png|jpe?g|webp|gif)$/;

export async function load(url, context, nextLoad) {
  if (ASSET_PATTERN.test(new URL(url).pathname)) {
    return { format: "module", shortCircuit: true, source: 'export default "";' };
  }
  return nextLoad(url, context);
}
