/**
 * The raw process runner is an engineering/E2E harness, not product UX. It is offered only when
 * explicitly requested AND the app is not packaged (same rule as the account test token), so an
 * installed build can never show it.
 */
export function resolveEngineeringTools(
  env: NodeJS.ProcessEnv,
  options: { isPackaged: boolean },
): boolean {
  return !options.isPackaged && env.ACEVRA_ENGINEERING_TOOLS?.trim() === "1";
}
