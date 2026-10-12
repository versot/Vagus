import { useCallback, useRef, useState } from "react";
import type { ChatMessage } from "../types.js";


interface LocalMessagePreview {
  sessionId: string | null;
  projectId: string | null;
  message: ChatMessage;
  confirmedMessageId?: string;
}

export function useMessagePreviews() {
  const [localMessagePreviews, setLocalMessagePreviews] = useState<LocalMessagePreview[]>([]);
  const localMessagePreviewsRef = useRef<LocalMessagePreview[]>([]);
  const updateMessagePreviews = useCallback((update: (current: LocalMessagePreview[]) => LocalMessagePreview[]) => {
    const current = localMessagePreviewsRef.current;
    const next = update(current);
    if (next === current) return;
    localMessagePreviewsRef.current = next;
    setLocalMessagePreviews(next);
  }, []);
  return { localMessagePreviews, updateMessagePreviews };
}
