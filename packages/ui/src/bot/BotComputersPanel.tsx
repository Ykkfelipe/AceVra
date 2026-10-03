/**
 * Bot 的「Computers」标签页：只读展示 Ace 可以使用的机器及其状态。
 *
 * 数据来自账户设备注册表（IPlatformService.account.listDevices()），不建第二条注册表；
 * 只展示（在线状态、角色、平台、能力），配对/重命名/撤销仍归账户的 Computers 管理区。
 * listDevices 不可用或抛错时只降级为本面板的提示，不影响对话与其他标签页。
 */
import { useCallback, useEffect, useState } from "react";
import { Monitor, RefreshCw, Server } from "lucide-react";
import type { AccountDevice, AccountDevicesView } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const PLATFORM_LABEL: Record<AccountDevice["platform"], string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

type ComputerRole = "thisDevice" | "desktop" | "node";

function roleOf(device: AccountDevice, thisDeviceId: string | null): ComputerRole {
  if (device.id === thisDeviceId) return "thisDevice";
  return device.type === "node" ? "node" : "desktop";
}

function ComputerRow({ device, role }: { device: AccountDevice; role: ComputerRole }) {
  const { intl } = useZCodeIntl();
  const revoked = device.presence === "revoked";
  const DeviceIcon = device.type === "node" ? Server : Monitor;
  return (
    <li
      className="flex flex-col gap-1.5 border-b border-border/60 py-3 last:border-b-0"
      data-testid="bot-computer-row"
      data-presence={device.presence}
      data-type={device.type}
    >
      <div className="flex items-center gap-2">
        <DeviceIcon className="size-4 shrink-0 text-foreground-subtle" aria-hidden />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground",
            revoked && "text-foreground-subtle",
          )}
        >
          {device.displayName}
        </span>
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            device.presence === "online" ? "bg-success" : "bg-foreground-subtlest",
          )}
        />
      </div>
      <p className="truncate pl-6 text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: `bot.computers.role.${role}` })}
        {" · "}
        {PLATFORM_LABEL[device.platform]}
        {" · "}
        {intl.formatMessage({ id: `bot.computers.presence.${device.presence}` })}
      </p>
      {device.capabilities.length > 0 ? (
        <div className="flex flex-wrap gap-1 pl-6">
          {device.capabilities.map((capability) => (
            <Badge key={capability} variant="outline">
              {intl.formatMessage({ id: `bot.computers.capability.${capability}` })}
            </Badge>
          ))}
        </div>
      ) : null}
    </li>
  );
}

export function BotComputersPanel() {
  const { intl } = useZCodeIntl();
  const account = usePlatform().account;
  const [view, setView] = useState<AccountDevicesView | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    const next = await account?.listDevices().catch(() => null);
    if (next) {
      setView(next);
      setFailed(false);
    } else {
      setFailed(true);
    }
  }, [account]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const devices = view?.devices ?? [];

  return (
    <div className="flex flex-col gap-2" data-testid="bot-computers-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "bot.computers.count" }, { count: String(devices.length) })}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void refresh()}
          aria-label={intl.formatMessage({ id: "bot.computers.refresh" })}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>
      {failed ? (
        <p className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "bot.computers.unavailable" })}
        </p>
      ) : !view ? null : devices.length === 0 ? (
        <p className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "bot.computers.empty" })}
        </p>
      ) : (
        <ul className="flex flex-col">
          {devices.map((device) => (
            <ComputerRow
              key={device.id}
              device={device}
              role={roleOf(device, view?.thisDeviceId ?? null)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
