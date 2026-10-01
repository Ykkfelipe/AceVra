import { useCallback, useEffect, useState } from "react";
import type { AccountDevice, AccountDevicesView, AccountPairingPreview } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useAccountText } from "./useAccountText.js";

const CAPABILITY_LABELS: Record<string, string> = {
  computerUse: "Computer Use",
  shell: "Shell",
  files: "Files",
  git: "Git",
  longTasks: "Long tasks",
  minecraft: "Minecraft",
};
const REFRESH_MS = 30_000;

/** Real registered devices only; nothing is hardcoded or implied to exist. */
export function AceVraDevicesSection() {
  const account = usePlatform().account;
  const text = useAccountText();
  const [view, setView] = useState<AccountDevicesView | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<AccountPairingPreview | null>(null);
  const [pairNote, setPairNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setView((await account?.listDevices().catch(() => null)) ?? null);
  }, [account]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);
  if (!account || !view) return null;

  const status = (device: AccountDevice) =>
    device.presence === "revoked"
      ? text("devices.revoked", "Revoked")
      : device.presence === "online"
        ? text("devices.online", "Online")
        : text("devices.offline", "Offline");
  const lookup = async () => {
    setPairNote(null);
    const result = await account?.lookupPairing(code);
    if (result?.status === "found") setPending(result.pairing);
    else
      setPairNote(
        result?.status === "too_many_attempts"
          ? text("pair.tooMany", "Too many attempts. Wait a few minutes and try again.")
          : result?.status === "unavailable"
            ? text("pair.unavailable", "Pairing is temporarily unavailable.")
            : text("pair.notFound", "No pending node found for that code. It may have expired."),
      );
  };
  const decide = async (decision: "approve" | "reject") => {
    if (!pending) return;
    const result = await account?.decidePairing(pending.id, decision);
    setPending(null);
    setCode("");
    setPairNote(
      result?.status === "approved"
        ? text("pair.approved", "Approved. The node will appear here once it connects.")
        : result?.status === "rejected"
          ? text("pair.rejected", "Rejected.")
          : text("pair.stale", "That pairing is no longer pending."),
    );
    await refresh();
  };
  const act = async (run: () => Promise<AccountDevicesView> | undefined) => {
    const next = await run();
    if (next) setView(next);
  };

  return (
    <div className="space-y-3" data-testid="acevra-devices-section">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">{text("devices.title", "Devices")}</h3>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            data-testid="acevra-devices-refresh"
            onClick={() => void refresh()}
          >
            {text("devices.refresh", "Refresh")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="acevra-pair-open"
            onClick={() => setPairOpen((open) => !open)}
          >
            {text("pair.open", "Pair a node")}
          </Button>
        </div>
      </div>
      {pairOpen && (
        <div className="space-y-2 rounded-md border p-3 text-sm" data-testid="acevra-pair-panel">
          {!pending ? (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void lookup();
              }}
            >
              <Input
                aria-label={text("pair.code", "Pairing code")}
                placeholder="ABCD-EFGH"
                value={code}
                maxLength={16}
                autoComplete="off"
                onChange={(event) => setCode(event.target.value)}
              />
              <Button type="submit" size="sm" data-testid="acevra-pair-lookup">
                {text("pair.lookup", "Find node")}
              </Button>
            </form>
          ) : (
            <div data-testid="acevra-pair-pending" className="space-y-2">
              <p className="font-medium">{pending.displayName}</p>
              <p className="text-muted-foreground">
                {pending.platform === "darwin"
                  ? "macOS"
                  : pending.platform === "win32"
                    ? "Windows"
                    : "Linux"}
                {" · "}
                {text("pair.review", "Only approve a node you started yourself.")}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  data-testid="acevra-pair-approve"
                  onClick={() => void decide("approve")}
                >
                  {text("pair.approve", "Approve")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="acevra-pair-reject"
                  onClick={() => void decide("reject")}
                >
                  {text("pair.reject", "Reject")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {pairNote && (
        <p className="text-sm text-muted-foreground" data-testid="acevra-pair-note">
          {pairNote}
        </p>
      )}
      {view.registration === "conflict" && (
        <p className="text-sm text-muted-foreground" data-testid="acevra-device-conflict">
          {text(
            "devices.conflict",
            "This installation is registered to a different AceVra account. Local features still work.",
          )}
        </p>
      )}
      {view.registration === "unavailable" && (
        <p className="text-sm text-muted-foreground">
          {text("devices.unavailable", "Devices are temporarily unavailable.")}
        </p>
      )}
      {view.devices.length === 0 && view.registration === "registered" && (
        <p className="text-sm text-muted-foreground">{text("devices.none", "No devices yet.")}</p>
      )}
      <ul className="space-y-2">
        {view.devices.map((device) => {
          const isThis = device.id === view.thisDeviceId;
          return (
            <li
              key={device.id}
              className="rounded-md border p-3 text-sm"
              data-testid="acevra-device-row"
              data-this-device={isThis ? "true" : "false"}
            >
              <div className="flex items-center gap-2">
                <span aria-hidden>{device.presence === "online" ? "●" : "○"}</span>
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
                      aria-label={text("devices.name", "Device name")}
                      value={editing.name}
                      maxLength={60}
                      onChange={(event) => setEditing({ id: device.id, name: event.target.value })}
                    />
                    <Button type="submit" size="sm" data-testid="acevra-device-rename-save">
                      {text("devices.save", "Save")}
                    </Button>
                  </form>
                ) : (
                  <span className="font-medium" data-testid="acevra-device-name">
                    {device.displayName}
                  </span>
                )}
              </div>
              <p className="text-muted-foreground">
                {isThis
                  ? `${text("devices.thisDevice", "This device")} · `
                  : device.type === "node"
                    ? `${text("devices.node", "Node")} · `
                    : ""}
                {status(device)}
                {device.capabilities.length > 0 &&
                  ` · ${device.capabilities.map((c) => CAPABILITY_LABELS[c] ?? c).join(", ")}`}
              </p>
              {device.presence !== "revoked" && (
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="acevra-device-rename"
                    onClick={() => setEditing({ id: device.id, name: device.displayName })}
                  >
                    {text("devices.rename", "Rename")}
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
                      {text("devices.revokeConfirm", "Confirm revoke")}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="acevra-device-revoke"
                      onClick={() => setRevoking(device.id)}
                    >
                      {text("devices.revoke", "Revoke")}
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        {text(
          "devices.note",
          "Revoking removes a device's account association. Local features on it keep working.",
        )}
      </p>
    </div>
  );
}
