import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

register("./uiAssetStubLoader.mjs", import.meta.url);
const { ZCodeIntlProvider } = await import("../src/i18n/IntlProvider.js");
const { MigrationCandidatesCard } = await import("../src/settings/MigrationCandidatesCard.js");

test("migration candidates keep selection, expansion, and escaped previews independent", () => {
  const sourcePath = "/private/local/path/should-not-render.jsonl";
  const markup = renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="en-US">
      <MigrationCandidatesCard
        supportState={{ supported: true }}
        candidates={[
          {
            provider: "codex",
            sessionId: "session-12345678",
            workspacePath: "/workspace/project",
            sourcePath,
            updatedAt: Date.parse("2026-09-23T12:00:00.000Z"),
            createdAt: Date.parse("2026-09-23T11:00:00.000Z"),
            previewTitle: "<script>title</script>",
            previewMessages: [
              { role: "user", content: "<script>user preview</script>" },
              { role: "assistant", content: "<img src=x onerror=assistant>" },
            ],
          },
        ]}
        selectedSessionIds={["session-12345678"]}
        selectedCount={1}
        expandedSessionIds={["session-12345678"]}
        importError={null}
        lastImportResult={null}
        isImporting={false}
        dateTimeFormatter={new Intl.DateTimeFormat("en-US", { dateStyle: "medium" })}
        onToggleSelection={() => {}}
        onToggleExpansion={() => {}}
        onSelectAll={() => {}}
        onClearSelection={() => {}}
        onImportSelected={() => {}}
      />
    </ZCodeIntlProvider>,
  );

  assert.match(markup, /Select session &lt;script&gt;title&lt;\/script&gt;/u);
  assert.match(markup, /&lt;script&gt;user preview&lt;\/script&gt;/u);
  assert.match(markup, /&lt;img src=x onerror=assistant&gt;/u);
  assert.doesNotMatch(markup, /<script>title<\/script>|<script>user preview<\/script>|<img src=x/u);
  assert.match(markup, /role="checkbox"/u);
  assert.match(markup, /aria-expanded="true"/u);
  assert.match(markup, /Select all/u);
  assert.match(markup, /Clear/u);
  assert.match(markup, /Import selected/u);
  assert.match(markup, /Workspace/u);
  assert.match(markup, /Last active/u);
  assert.equal(markup.includes(sourcePath), false);
});
