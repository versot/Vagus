import type { BrowserElementReference, MessageAttachment } from "@vagus/protocol";

export type PendingPermission = { resolve: (optionId: string | null) => void; options: Array<{ optionId: string; kind: string; label: string }> };

export type PendingPrompt = {
  prompt: string;
  attachments: MessageAttachment[];
  clientMessageId?: string;
  messageId?: string;
  displayText?: string;
  browserElements?: BrowserElementReference[];
  queuedMode?: "steer" | "follow-up";
  resolve?: () => void;
  reject?: (error: Error) => void;
};

export type ClaudeRecord = Record<string, unknown>;
