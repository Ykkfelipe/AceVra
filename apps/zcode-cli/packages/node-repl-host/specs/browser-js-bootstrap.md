# Browser JS bootstrap and import diagnostics

The MCP `js` host owns browser-runtime initialization for each fresh kernel. It installs the existing `@zcode/core/browser-client` facade over its authenticated browser broker bridge before executing model-authored action code. The model selects a browser and acts on tabs, but does not resolve plugin paths or load the browser client. The broker remains the sole owner of browser state and screenshot results; this change does not alter artifact registration or client delivery.

The official browser plugin's explicit `setupBrowserRuntime({ globals: globalThis })` remains accepted for older cells. Reinitializing the facade in the same kernel is safe because it binds the same broker transport and does not open a browser or create a tab.

`NodeReplSession` rejects a top-level static ESM `import` declaration before its IIFE is passed to `vm.Script`, returning `node_repl_static_import_unsupported` with guidance to use `await import(...)`. Dynamic imports, `import.meta`, `o.import` property access, comments, strings, templates, and nested text are not rejected. A static import that appears only after a top-level `return` is not detected (the module parser stops at the `return`) and still surfaces the raw SyntaxError. No source rewriting occurs. This generic syntax check does not depend on browser availability.

Acceptance: an MCP `js` call can use `agent.browsers` without a bootstrap snippet; existing explicit setup still works; a recovered Nike-style static-import cell returns the structured diagnostic and never reaches the broker; a direct Electron-host browser call opens `https://example.com`, emits one PNG screenshot, and the existing artifact hook registers it once without exposing a host path.
