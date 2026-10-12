import type { SessionUiState } from "@vagus/protocol";
import { useCallback, useEffect, useState, type SetStateAction } from "react";

type Draft = { text: string; handled?: string; undo?: { before: string; after: string } };

/** Keeps each conversation's draft independent from extension suggestions. */
export function useExtensionDraft(sessionId: string | null, suggestion: SessionUiState["editorText"], dismiss: (sessionId: string, requestId: string) => void) {
  const [drafts, setDrafts] = useState<Map<string, Draft>>(() => new Map());
  const key = sessionId ?? "new-chat";
  const draft = drafts.get(key);
  const composer = draft?.text ?? "";
  const pending = suggestion && suggestion.requestId !== draft?.handled ? suggestion : undefined;
  const setComposer = useCallback((value: SetStateAction<string>, targetSessionId: string | null = sessionId) => {
    const targetKey = targetSessionId ?? "new-chat";
    setDrafts((current) => {
      const previous = current.get(targetKey);
      const text = typeof value === "function" ? value(previous?.text ?? "") : value;
      const next = new Map(current);
      next.set(targetKey, { ...previous, text });
      return next;
    });
  }, [sessionId]);

  const accept = useCallback((mode: "replace" | "insert") => {
    if (!sessionId || !pending) return;
    setDrafts((current) => {
      const previous = current.get(key);
      const before = previous?.text ?? "";
      const after = mode === "replace" ? pending.text : `${before}${before && pending.text ? "\n" : ""}${pending.text}`;
      const next = new Map(current);
      next.set(key, { text: after, handled: pending.requestId, undo: { before, after } });
      return next;
    });
    dismiss(sessionId, pending.requestId);
  }, [dismiss, key, pending, sessionId]);

  useEffect(() => {
    if (pending && !composer.trim()) accept("replace");
  }, [accept, composer, pending]);

  const discard = () => {
    if (!sessionId || !pending) return;
    setDrafts((current) => {
      const next = new Map(current);
      next.set(key, { ...current.get(key), text: composer, handled: pending.requestId });
      return next;
    });
    dismiss(sessionId, pending.requestId);
  };
  const canUndo = Boolean(draft?.undo && draft.undo.after === composer);
  const undo = () => {
    setDrafts((current) => {
      const previous = current.get(key);
      if (!previous?.undo || previous.undo.after !== previous.text) return current;
      const next = new Map(current);
      next.set(key, { text: previous.undo.before, handled: previous.handled });
      return next;
    });
  };
  return { composer, setComposer, suggestion: pending, accept, discard, canUndo, undo };
}
