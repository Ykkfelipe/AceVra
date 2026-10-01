#!/usr/bin/env node
// Dev launcher: runs the TypeScript sources through tsx. A bundled build comes later.
import { register } from "tsx/esm/api";
register();
const { main } = await import("../src/cli.ts");
process.exitCode = await main(process.argv.slice(2));
