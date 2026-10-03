/**
 * The desktop renderer imports stylesheets for their side effects (the main window
 * pulls in `@zcode/ui/styles.css`, the account window pulls in its own tokens). Vite
 * resolves those at build time; this declaration keeps `tsc` from reporting the
 * imports as unresolved modules.
 */
declare module "*.css";
