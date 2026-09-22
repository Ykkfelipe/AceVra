export interface CustomForkProductConfig {
  applicationName: string;
  remoteRoute: string;
  telemetryEnabled: boolean;
  remoteWebSocketPath: string;
}

export const CUSTOM_FORK_PRODUCT_DEFAULTS: CustomForkProductConfig = {
  applicationName: "ZCode Fork Dev",
  remoteRoute: "/fork",
  telemetryEnabled: false,
  remoteWebSocketPath: "/ws",
};

export function resolveCustomForkProductConfig(
  overrides: Partial<CustomForkProductConfig> = {},
): CustomForkProductConfig {
  return { ...CUSTOM_FORK_PRODUCT_DEFAULTS, ...overrides };
}
