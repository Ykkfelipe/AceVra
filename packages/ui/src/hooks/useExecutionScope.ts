import { useEffect, useRef } from "react";
import { executionScopeKey, useExecutionTargetStore } from "@/store/executionTargetStore.js";

/**
 * The composer's work scope (`session:<id>` or `draft:<workspaceKey>`). When the same workspace's
 * draft becomes a session (first send), the draft's attached tasks merge into the session once
 * (unioned, since an agent-started task may already be attached to the session).
 */
export function useExecutionScope(
  workspace: { workspacePath: string; workspaceIdentity?: string },
  sessionId: string | null,
): string {
  const scope = executionScopeKey(workspace, sessionId);
  const draftScope = executionScopeKey(workspace, null);
  const previous = useRef(scope);
  useEffect(() => {
    const store = useExecutionTargetStore.getState();
    if (previous.current === draftScope && scope !== draftScope) {
      store.adoptDraft(draftScope, scope);
    }
    previous.current = scope;
    store.noteActiveScope(scope);
  }, [scope, draftScope]);
  return scope;
}
