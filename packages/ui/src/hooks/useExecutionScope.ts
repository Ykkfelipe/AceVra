import { useEffect, useRef } from "react";
import { executionScopeKey, useExecutionTargetStore } from "@/store/executionTargetStore.js";

/**
 * The composer's execution scope (`session:<id>` or `draft:<workspaceKey>`). When the same
 * workspace's draft becomes a session (first send), the draft's Run-on choice and attached tasks
 * move to the session once; the store refuses to overwrite a session that already has state.
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
