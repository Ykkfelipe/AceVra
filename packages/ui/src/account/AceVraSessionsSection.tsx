import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import {
  accountSessionActivity,
  accountSessionDevice,
  describeAccountSessionRevoke,
  splitAccountSessions,
  type AccountSession,
  type AccountSessionsView,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useAccountText } from "./useAccountText.js";

/**
 * "Where you're signed in" — human login sessions.
 *
 * Deliberately a separate section from Computers. A session is a login; a computer is
 * a machine this account may drive. They have different identifiers and different
 * consequences, and merging them would imply that signing in trusts a machine.
 *
 * The current session has no revoke control. Sign out in this window is already the
 * authoritative way to end it: it clears the locally cached token, which a server-side
 * revoke cannot do.
 */
export function AceVraSessionsSection() {
  const account = usePlatform().account;
  const text = useAccountText();
  const [view, setView] = useState<AccountSessionsView | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  // Sessions we have ended. A refresh issued before Clerk processed a revoke can come
  // back with that session still listed, so ended ids are filtered on every list
  // rather than removed once — an ordering ticket cannot do this, because the list
  // that needs filtering is the *newer* one.
  const ended = useRef(new Set<string>());
  // Orders two concurrent reads so the slower one cannot overwrite the newer.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++seq.current;
    const next = (await account?.listSessions().catch(() => null)) ?? null;
    if (ticket !== seq.current || !next) return;
    const hidden = ended.current;
    setView(
      hidden.size === 0
        ? next
        : { ...next, sessions: next.sessions.filter((s) => !hidden.has(s.id)) },
    );
  }, [account]);

  useEffect(() => {
    void load();
  }, [load]);

  const now = Date.now();
  const { current, others } = splitAccountSessions(view?.sessions ?? []);

  if (!view) {
    return (
      <div className="space-y-2" data-testid="acevra-sessions-section">
        <p className="text-ui-base text-foreground-subtle" role="status" aria-busy="true">
          {text("sessions.loading", "Loading your sign-ins…")}
        </p>
      </div>
    );
  }

  const revoke = async (id: string) => {
    setBusy(id);
    try {
      const result = await account?.revokeSession(id);
      const outcome = describeAccountSessionRevoke(result ?? { status: "unavailable" }, text);
      setNote(outcome);
      if (outcome.ok) {
        // Drop it immediately rather than waiting for a round trip, and remember it so
        // an in-flight refresh cannot put it back.
        ended.current.add(id);
        setView((previous) =>
          previous
            ? { ...previous, sessions: previous.sessions.filter((s) => s.id !== id) }
            : previous,
        );
      }
    } catch {
      setNote({
        ok: false,
        message: text(
          "sessions.revokeUnavailable",
          "Couldn't end that session. Check your connection and try again.",
        ),
      });
    } finally {
      // Always clear, so a failed call cannot strand the row in its confirm state
      // with no way out and no explanation.
      setRevoking(null);
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3" data-testid="acevra-sessions-section">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-ui-base font-medium text-foreground">
          {text("sessions.title", "Where you're signed in")}
        </h3>
        <Button
          size="icon-sm"
          variant="ghost"
          data-testid="acevra-sessions-refresh"
          aria-label={text("sessions.refresh", "Refresh")}
          onClick={() => void load()}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>
      <p className="text-ui-sm text-foreground-subtle">
        {text(
          "sessions.description",
          "Sign-ins to your AceVra account. These are not the computers your account can use.",
        )}
      </p>

      {view.partial && !view.unavailable && (
        <p className="text-ui-sm text-foreground-subtle" data-testid="acevra-sessions-partial">
          {text(
            "sessions.partial",
            "Showing the most recent sign-ins. Some older sessions are not listed.",
          )}
        </p>
      )}
      {view.unavailable ? (
        <div className="flex items-center gap-2">
          <p
            className="text-ui-sm text-foreground-subtle"
            data-testid="acevra-sessions-unavailable"
            role="status"
          >
            {text(
              "sessions.unavailable",
              "Couldn't load your sign-ins. AceVra Account may be unreachable.",
            )}
          </p>
          <Button
            size="sm"
            variant="ghost"
            data-testid="acevra-sessions-retry"
            onClick={() => void load()}
          >
            {text("retry", "Try again")}
          </Button>
        </div>
      ) : others.length === 0 && !current ? (
        <p className="text-ui-sm text-foreground-subtle" data-testid="acevra-sessions-empty">
          {text("sessions.empty", "No other sign-ins found.")}
        </p>
      ) : (
        <ul className="space-y-2">
          {current && (
            <li>
              <SessionRow
                session={current}
                now={now}
                text={text}
                badge={text("sessions.thisSession", "This sign-in")}
                testId="acevra-session-current"
              />
            </li>
          )}
          {others.map((session) => (
            <li key={session.id} className="flex items-center justify-between gap-2">
              <SessionRow session={session} now={now} text={text} testId="acevra-session-row" />
              {revoking === session.id ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy === session.id}
                  data-testid="acevra-session-revoke-confirm"
                  onClick={() => void revoke(session.id)}
                >
                  {busy === session.id
                    ? text("sessions.revoking", "Signing out…")
                    : text("sessions.revokeConfirm", "Confirm")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  data-testid="acevra-session-revoke"
                  onClick={() => {
                    setNote(null);
                    setRevoking(session.id);
                  }}
                >
                  {text("sessions.revoke", "Sign out")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {note && (
        <p
          role="status"
          className={note.ok ? "text-ui-sm text-foreground-subtle" : "text-ui-sm text-destructive"}
          data-testid={note.ok ? "acevra-sessions-revoked" : "acevra-sessions-revoke-failed"}
        >
          {note.message}
        </p>
      )}
    </div>
  );
}

/**
 * One sign-in. Everything here is something Clerk reported: if there is no device
 * description, none is shown rather than a guess.
 */
function SessionRow({
  session,
  now,
  text,
  badge,
  testId,
}: {
  session: AccountSession;
  now: number;
  text: (id: string, fallback: string) => string;
  badge?: string;
  testId: string;
}) {
  const activity = accountSessionActivity(session, now);
  const device = accountSessionDevice(session);
  const when = describeActivity(activity, text);
  return (
    <div className="min-w-0 space-y-0.5" data-testid={testId}>
      <p className="truncate text-ui-base font-medium">
        {badge ?? device ?? text("sessions.unknownDevice", "Sign-in")}
      </p>
      <p className="text-ui-sm text-foreground-subtle">
        {device && badge ? `${device} · ` : ""}
        {when}
      </p>
    </div>
  );
}

function describeActivity(
  activity: ReturnType<typeof accountSessionActivity>,
  text: (id: string, fallback: string) => string,
): string {
  switch (activity.kind) {
    case "justNow":
      return text("sessions.activeNow", "Active now");
    case "minutes":
      return fill(text("sessions.activeMinutes", "Active {n} min ago"), activity.value);
    case "hours":
      return fill(text("sessions.activeHours", "Active {n} h ago"), activity.value);
    case "days":
      return fill(text("sessions.activeDays", "Active {n} d ago"), activity.value);
    default:
      return text("sessions.activityUnknown", "Last activity unknown");
  }
}

/** `{n}` is interpolated here so the locale file stays a plain string pair. */
function fill(message: string, value: number): string {
  return message.replace("{n}", String(value));
}
