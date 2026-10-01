import { useEffect, useState } from "react";
import { DEFAULT_WORKER_PORT, type ComputerTestResult } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useSshComputers } from "@/hooks/useComputer.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useAccountText } from "./useAccountText.js";

const HOST_ALIAS = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,127}$/;

/**
 * Settings → Computers: SSH computers (acevra-agent-computer.md §3.2). Local only — no account
 * needed; stores alias + worker port, never a credential (the worker token stays in Main memory).
 */
export function SshComputersSection() {
  const platform = usePlatform();
  const { computers, list, setList } = useSshComputers();
  const text = useAccountText();
  const [aliases, setAliases] = useState<string[]>([]);
  const [hostAlias, setHostAlias] = useState("");
  const [name, setName] = useState("");
  const [port, setPort] = useState(String(DEFAULT_WORKER_PORT));
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ComputerTestResult | null>(null);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    let active = true;
    void platform
      .listSSHConfigAliases()
      .then((options) => active && setAliases(options.map((option) => option.alias)))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [platform]);

  if (!computers) return null;

  const parsed = () => {
    const workerPort = Number(port);
    const alias = hostAlias.trim();
    const ok =
      HOST_ALIAS.test(alias) &&
      Number.isInteger(workerPort) &&
      workerPort > 0 &&
      workerPort < 65536;
    setInvalid(!ok);
    return ok ? { hostAlias: alias, workerPort } : null;
  };
  const test = async () => {
    const input = parsed();
    if (!input) return;
    setTesting(true);
    setResult(null);
    setResult(
      await computers.test(input).catch(() => ({ ok: false as const, reason: "internal" })),
    );
    setTesting(false);
  };
  const add = async () => {
    const input = parsed();
    if (!input) return;
    setList(await computers.add({ ...input, name: name.trim() || input.hostAlias }));
    setHostAlias("");
    setName("");
    setPort(String(DEFAULT_WORKER_PORT));
    setResult(null);
  };

  return (
    <div className="space-y-3" data-testid="ssh-computers-section">
      <div>
        <h3 className="text-ui-base font-semibold text-foreground">
          {text("computers.ssh.title", "SSH computers")}
        </h3>
        <p className="text-ui-sm text-foreground-subtle">
          {text(
            "computers.ssh.description",
            "Computers you reach with your own SSH config that run the AceVra computer worker.",
          )}
        </p>
      </div>
      {list && list.length === 0 ? (
        <p className="text-ui-sm text-foreground-subtle">
          {text("computers.ssh.none", "No SSH computers yet.")}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {(list ?? []).map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-3 px-3 py-2"
              data-testid="ssh-computer-row"
            >
              <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">
                {item.name}
              </span>
              <span className="truncate font-mono text-ui-sm text-foreground-subtle">
                {item.hostAlias}:{item.workerPort}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void computers.remove(item.id).then(setList)}
              >
                {text("computers.ssh.remove", "Remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-36 flex-1 flex-col gap-1 text-ui-sm text-foreground-subtle">
          {text("computers.ssh.alias", "SSH host")}
          <Input
            value={hostAlias}
            list="ssh-computer-aliases"
            data-testid="ssh-computer-alias"
            onChange={(event) => setHostAlias(event.target.value)}
          />
          <datalist id="ssh-computer-aliases">
            {aliases.map((alias) => (
              <option key={alias} value={alias} />
            ))}
          </datalist>
        </label>
        <label className="flex min-w-28 flex-1 flex-col gap-1 text-ui-sm text-foreground-subtle">
          {text("computers.ssh.name", "Name")}
          <Input
            value={name}
            data-testid="ssh-computer-name"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="flex w-24 flex-col gap-1 text-ui-sm text-foreground-subtle">
          {text("computers.ssh.port", "Worker port")}
          <Input
            value={port}
            inputMode="numeric"
            onChange={(event) => setPort(event.target.value)}
          />
        </label>
        <Button
          variant="outline"
          size="sm"
          disabled={testing}
          data-testid="ssh-computer-test"
          onClick={() => void test()}
        >
          {testing
            ? text("computers.ssh.testing", "Testing…")
            : text("computers.ssh.test", "Test connection")}
        </Button>
        <Button
          size="sm"
          disabled={testing}
          data-testid="ssh-computer-add"
          onClick={() => void add()}
        >
          {text("computers.ssh.add", "Add computer")}
        </Button>
      </div>
      {invalid ? (
        <p className="text-ui-sm text-destructive">
          {text("computers.ssh.invalid", "Enter an SSH host and a port between 1 and 65535.")}
        </p>
      ) : null}
      {result ? (
        <p className="text-ui-sm text-foreground-subtle" data-testid="ssh-computer-test-result">
          {result.ok
            ? text("computers.ssh.testOk", "Connected · screen {size}").replace(
                "{size}",
                `${result.screen.width}×${result.screen.height}`,
              )
            : text("computers.ssh.testFailed", "Couldn't connect ({reason})").replace(
                "{reason}",
                result.reason,
              )}
        </p>
      ) : null}
    </div>
  );
}
