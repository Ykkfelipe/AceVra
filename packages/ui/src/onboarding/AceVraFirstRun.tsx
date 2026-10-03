import { useState } from "react";
import type { AceVraConnectionInput, AceVraProviderChoice } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const providers: { choice: AceVraProviderChoice; name: string }[] = [
  { choice: "openai", name: "OpenAI" },
  { choice: "anthropic", name: "Anthropic" },
  { choice: "zai", name: "Z.ai" },
  { choice: "compatible", name: "Azure / OpenAI-compatible" },
];
export function AceVraFirstRun({
  onComplete,
}: {
  onComplete: (reason: "apiKey" | "skip") => void | Promise<void>;
}) {
  const { acevraSetupService: setup } = useServices();
  const requestLoginEntry = useZCodeStore((state) => state.requestLoginEntry);
  const { intl } = useZCodeIntl();
  const text = (id: string, fallback: string) => {
    const key = `acevra.setup.${id}`;
    const message = intl.formatMessage({ id: key });
    return message === key ? fallback : message;
  };
  const [choice, setChoice] = useState<AceVraConnectionInput["choice"] | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [credentialHeader, setCredentialHeader] = useState<"bearer" | "api-key">("bearer");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelId, setModelId] = useState("");
  const [apiType, setApiType] =
    useState<AceVraConnectionInput["apiType"]>("openai-chat-completions");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch {
      // 不展示可能携带 API Key 的底层请求异常；用户可在原表单修正配置重试。
      setError(
        text("saveError", "Connection could not be saved. Check your endpoint, API key and model."),
      );
    } finally {
      setBusy(false);
    }
  };
  const select = (provider: AceVraProviderChoice) =>
    run(async () => {
      if (!setup) throw new Error("Setup unavailable");
      const route = await setup.getProviderRoute(provider);
      if (route.kind === "oauth") {
        requestLoginEntry(route.providerId);
        return;
      }
      setChoice(provider as AceVraConnectionInput["choice"]);
      setCredentialHeader("bearer");
      setApiKey("");
      setModelId("");
      setBaseUrl(
        provider === "openai"
          ? "https://api.openai.com/v1"
          : provider === "anthropic"
            ? "https://api.anthropic.com/v1"
            : "",
      );
      setApiType(
        provider === "anthropic"
          ? "anthropic-messages"
          : provider === "openai"
            ? "openai-responses"
            : "openai-chat-completions",
      );
    });
  return (
    <main
      className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground"
      data-testid="acevra-first-run"
    >
      <section className="w-full max-w-md space-y-6">
        <header className="space-y-2">
          <h1 className="text-ui-xl font-semibold">{text("welcome", "Welcome to AceVra")}</h1>
          <p className="text-ui-base text-foreground-subtle">
            {text("choose", "Choose how you want to connect")}
          </p>
        </header>
        {!choice ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {providers.map((provider) => (
              <Button
                key={provider.choice}
                variant="outline"
                disabled={busy}
                className="h-20 whitespace-normal"
                data-testid={`acevra-provider-${provider.choice}`}
                onClick={() => void select(provider.choice)}
              >
                {provider.name}
              </Button>
            ))}
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                if (!setup) throw new Error("Setup unavailable");
                const view = await setup.configureConnection({
                  choice,
                  apiKey,
                  credentialHeader,
                  baseUrl,
                  modelId,
                  apiType,
                });
                if (!view.shellAllowed) throw new Error("Connection unavailable");
                await onComplete("apiKey");
              });
            }}
          >
            <h2 className="font-medium">
              {providers.find((provider) => provider.choice === choice)?.name}
            </h2>
            <div className="space-y-2">
              <Label htmlFor="setup-endpoint">{text("endpoint", "API endpoint")}</Label>
              <Input
                id="setup-endpoint"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                required
                type="url"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="setup-key">{text("key", "API key")}</Label>
              <Input
                id="setup-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="setup-model">{text("model", "Model ID / deployment name")}</Label>
              <Input
                id="setup-model"
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                required
              />
            </div>
            {choice === "compatible" && (
              <div className="space-y-2">
                <Label htmlFor="setup-format">{text("format", "API format")}</Label>
                <Select
                  value={apiType}
                  onValueChange={(value) => setApiType(value as AceVraConnectionInput["apiType"])}
                >
                  <SelectTrigger id="setup-format" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai-chat-completions">OpenAI Chat Completions</SelectItem>
                    <SelectItem value="openai-responses">OpenAI Responses</SelectItem>
                    <SelectItem value="anthropic-messages">Anthropic Messages</SelectItem>
                  </SelectContent>
                </Select>
                <Label htmlFor="setup-credential-header">
                  {text("credentialHeader", "Credential header")}
                </Label>
                <Select
                  value={credentialHeader}
                  onValueChange={(value) => setCredentialHeader(value as "bearer" | "api-key")}
                >
                  <SelectTrigger id="setup-credential-header" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bearer">Authorization: Bearer</SelectItem>
                    <SelectItem value="api-key">api-key</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-ui-sm text-foreground-subtle">
                  {text(
                    "azure",
                    "Use an API-key endpoint supported by the selected format. Azure Entra sign-in is not supported here.",
                  )}
                </p>
              </div>
            )}
            <div className="flex gap-3">
              <Button type="submit" disabled={busy}>
                {text("connect", "Connect")}
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setChoice(null)}>
                {text("back", "Back")}
              </Button>
            </div>
          </form>
        )}
        {error && (
          <p role="alert" className="text-ui-sm text-destructive">
            {error}
          </p>
        )}
        <Button
          variant="ghost"
          disabled={busy}
          data-testid="acevra-configure-later"
          onClick={() =>
            void run(async () => {
              if (!setup) throw new Error("Setup unavailable");
              await setup.defer();
              await onComplete("skip");
            })
          }
        >
          {text("later", "Configure later")}
        </Button>
        {/* Provider credentials and the AceVra account are separate authorities: a model
            provider key is not an AceVra sign-in, and neither grants access to an
            external service's data. */}
        <footer className="space-y-1 border-t border-card-border pt-4">
          <p className="text-ui-sm text-foreground-subtlest">
            {text(
              "providerBoundary",
              "Connecting a model provider is separate from your AceVra account, and neither connects your personal data.",
            )}
          </p>
        </footer>
      </section>
    </main>
  );
}
