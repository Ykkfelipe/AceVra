import { useCallback } from "react";
import type { Locale } from "@zcode/shared";
import { useCodingPlanUpgradeDialog } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodingPlanFunnelContext } from "@/lib/codingPlanFunnelTelemetry.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";

/**
 * 账户 footer（语言、主题、设置、升级）的交互接线。
 *
 * footer 从 Coding 侧栏底部移到全局导航栏底部（personal-bot spec §16.1），
 * 这里收拢原来写在 WorkspaceSidebar 里的同一组处理函数，行为逐字不变。
 */
export function useWorkspaceSidebarFooterControls() {
  const { localePreference, setLocalePreference } = useZCodeIntl();
  const setTheme = useZCodeStore((state) => state.setTheme);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const { openCodingPlanUpgrade } = useCodingPlanUpgradeDialog();
  const localeMenuValue: Locale | "system" =
    localePreference === "system" ? "system" : localePreference;

  const onThemeChange = useCallback(
    (value: string) => {
      if (
        value === "light" ||
        value === "dark" ||
        value === "zai-light" ||
        value === "zai-dark" ||
        value === "system"
      ) {
        setTheme(value);
      }
    },
    [setTheme],
  );

  const onLocaleChange = useCallback(
    (value: string) => {
      if (value === "system") {
        setLocalePreference("system");
        return;
      }
      if (value === "zh-CN" || value === "en-US") {
        setLocalePreference(value as Locale);
      }
    },
    [setLocalePreference],
  );

  const onUpgradeClick = useCallback(
    (providerId: string, funnelContext?: CodingPlanFunnelContext) => {
      openCodingPlanUpgrade({ providerId, funnelContext });
    },
    [openCodingPlanUpgrade],
  );

  return {
    localeMenuValue,
    onLocaleChange,
    onThemeChange,
    onSettingsButtonClick: openSettingsTab,
    onUsageClick: openSettingsTab,
    onUpgradeClick,
  };
}
