import { useCallback, useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import type { AccountDevice, AccountDevicesView, AccountPairingPreview } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { describeDeviceRole } from "./executionPresentation.js";
import { useAccountText } from "./useAccountText.js";

const REFRESH_MS = 30_000;
const PLATFORM_LABEL: Record<AccountDevice["platform"], string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

/**
 * 「Computers」管理：名称、在线状态、这台电脑 / 已连接的电脑、连接（配对）、重命名、移除（撤销）。
 * 只做管理，不出现执行/命令/能力等术语；agent 用哪台电脑由对话决定（acevra-agent-computer.md）。
 */
export function AceVraComputersSection() {
  const account = usePlatform().account;
  const text = useAccountText();
  const [view, setView] = useState<AccountDevicesView | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<AccountPairingPreview | null>(null);
  const [pairNote, setPairNote] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const refresh = useCallback(async () => {
    setView((await account?.listDevices().catch(() => null)) ?? null);
  }, [account]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  if (!account || !view) return null;

  const presence = (device: AccountDevice) =>
    device.presence === "revoked"
      ? text("computers.removed", "Removed")
      : device.presence === "online"
        ? text("computers.online", "Online")
        : text("computers.offline", "Offline");
  const role = (device: AccountDevice) => {
    const kind = describeDeviceRole(device, view.thisDeviceId);
    return kind === "thisDevice"
      ? text("computers.thisComputer", "This computer")
      : kind === "node"
        ? text("computers.connected", "Connected computer")
        : text("computers.otherApp", "AceVra app");
  };
  const lookup = async () => {
    setPairNote(null);
    const result = await account?.lookupPairing(code);
    if (result?.status === "found") setPending(result.pairing);
    else
      setPairNote(
        result?.status === "too_many_attempts"
          ? text("connect.tooMany", "Too many attempts. Wait a few minutes and try again.")
          : result?.status === "unavailable"
            ? text("connect.unavailable", "Connecting is temporarily unavailable.")
            : text(
                "connect.notFound",
                "No computer is waiting with that code. It may have expired.",
              ),
      );
  };
  const decide = async (decision: "approve" | "reject") => {
    if (!pending) return;
    const result = await account?.decidePairing(pending.id, decision);
    setPending(null);
    setCode("");
    setPairNote(
      result?.status === "approved"
        ? text("connect.approved", "Approved. The computer will appear here once it connects.")
        : result?.status === "rejected"
          ? text("connect.rejected", "Rejected.")
          : text("connect.stale", "That request is no longer waiting."),
    );
    await refresh();
  };
  const act = async (run: () => Promise<AccountDevicesView> | undefined) => {
    const next = await run();
    if (next) setView(next);
  };

  return (
    <div className="space-y-2" data-testid="acevra-devices-section">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-ui-base font-medium text-foreground">
          {text("computers.title", "Computers")}
        </h3>
        <div className="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            data-testid="acevra-devices-refresh"
            aria-label={text("computers.refresh", "Refresh")}
            onClick={() => void refresh()}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="acevra-pair-open"
            aria-expanded={pairOpen}
            onClick={() => setPairOpen((open) => !open)}
          >
            {text("connect.open", "Connect a computer")}
          </Button>
        </div>
      </div>
      <p className="text-ui-sm text-foreground-subtle">
        {text(
          "computers.description",
          "Computers connected to your AceVra account. The agent can use them when you ask.",
        )}
      </p>
      {pairOpen && (
        <div
          className="space-y-2 rounded-xl border border-card-border bg-card p-3 text-ui-base"
          data-testid="acevra-pair-panel"
        >
          {!pending && (
            <p className="text-ui-sm text-foreground-subtle" data-testid="acevra-connect-how-to">
              {text(
                "connect.howTo",
                "On the other computer, start AceVra Node and enter the code it shows.",
              )}
            </p>
          )}
          {!pending ? (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void lookup();
              }}
            >
              <Input
                aria-label={text("connect.code", "Connection code")}
                placeholder="ABCD-EFGH"
                value={code}
                maxLength={16}
                autoComplete="off"
                onChange={(event) => setCode(event.target.value)}
              />
              <Button type="submit" size="sm" data-testid="acevra-pair-lookup">
                {text("connect.lookup", "Find computer")}
              </Button>
            </form>
          ) : (
            <div data-testid="acevra-pair-pending" className="space-y-2">
              <p className="font-medium">{pending.displayName}</p>
              <p className="text-ui-sm text-foreground-subtle">
                {PLATFORM_LABEL[pending.platform]}
                {" · "}
                {text("connect.review", "Only approve a computer you set up yourself.")}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  data-testid="acevra-pair-approve"
                  onClick={() => void decide("approve")}
                >
                  {text("connect.approve", "Approve")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="acevra-pair-reject"
                  onClick={() => void decide("reject")}
                >
                  {text("connect.reject", "Reject")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {pairNote && (
        <p className="text-ui-sm text-foreground-subtle" data-testid="acevra-pair-note">
          {pairNote}
        </p>
      )}
      {view.registration === "conflict" && (
        <div className="space-y-2" data-testid="acevra-device-conflict">
          <p className="text-ui-sm text-foreground-subtle">
            {text(
              "computers.conflict",
              "This Mac is already registered to a different AceVra account. Local features still work.",
            )}
          </p>
          {/* The installation id is bound to the first account that claimed it, so there
              is no way to re-claim it from here. Minting a new local identity registers
              this machine again under the current account and leaves the other account's
              device untouched — nothing is transferred or reassigned. */}
          <Button
            variant="outline"
            size="sm"
            disabled={resetting}
            data-testid="acevra-device-reset-identity"
            onClick={() =>
              void (async () => {
                setResetting(true);
                try {
                  setView(await account?.resetDeviceIdentity());
                } catch {
                  setView((await account?.listDevices().catch(() => null)) ?? null);
                } finally {
                  setResetting(false);
                }
              })()
            }
          >
            {resetting
              ? text("computers.conflictResetting", "Setting up this Mac…")
              : text("computers.conflictReset", "Use this Mac with the current account")}
          </Button>
        </div>
      )}
      {view.registration === "unavailable" && (
        <p className="text-ui-sm text-foreground-subtle">
          {text("computers.unavailable", "Computers are temporarily unavailable.")}
        </p>
      )}
      {view.devices.length === 0 && view.registration === "registered" && (
        <p className="text-ui-sm text-foreground-subtle">
          {text("computers.none", "No computers yet.")}
        </p>
      )}
      {view.devices.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-card-border bg-card">
          {view.devices.map((device) => {
            const isThis = device.id === view.thisDeviceId;
            const revoked = device.presence === "revoked";
            return (
              <li
                key={device.id}
                className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-ui-base"
                data-testid="acevra-device-row"
                data-this-device={isThis ? "true" : "false"}
                data-presence={device.presence}
                data-capabilities={device.capabilities.join(",")}
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    device.presence === "online" ? "bg-success" : "bg-foreground-subtlest",
                  )}
                />
                <div className="min-w-0 flex-1">
                  {editing?.id === device.id ? (
                    <form
                      className="flex gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const name = editing.name;
                        setEditing(null);
                        void act(() => account.renameDevice(device.id, name));
                      }}
                    >
                      <Input
                        autoFocus
                        aria-label={text("computers.name", "Computer name")}
                        value={editing.name}
                        maxLength={60}
                        onChange={(event) =>
                          setEditing({ id: device.id, name: event.target.value })
                        }
                      />
                      <Button type="submit" size="sm" data-testid="acevra-device-rename-save">
                        {text("computers.save", "Save")}
                      </Button>
                    </form>
                  ) : (
                    <p
                      className={cn("truncate font-medium", revoked && "text-foreground-subtle")}
                      data-testid="acevra-device-name"
                    >
                      {device.displayName}
                    </p>
                  )}
                  <p className="text-ui-sm text-foreground-subtle">
                    {`${role(device)} · ${presence(device)}`}
                  </p>
                </div>
                {!revoked && editing?.id !== device.id && (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="acevra-device-rename"
                      onClick={() => setEditing({ id: device.id, name: device.displayName })}
                    >
                      {text("computers.rename", "Rename")}
                    </Button>
                    {revoking === device.id ? (
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid="acevra-device-revoke-confirm"
                        onClick={() => {
                          setRevoking(null);
                          void act(() => account.revokeDevice(device.id));
                        }}
                      >
                        {text("computers.removeConfirm", "Confirm remove")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid="acevra-device-revoke"
                        onClick={() => setRevoking(device.id)}
                      >
                        {text("computers.remove", "Remove")}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-ui-sm text-foreground-subtle">
        {text(
          "computers.note",
          "Removing a computer disconnects it from your account. Nothing on it is deleted.",
        )}
      </p>
    </div>
  );
}
