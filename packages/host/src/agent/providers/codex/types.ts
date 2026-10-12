import type { MessageAttachment, UserInteraction } from "@vagus/protocol";

export type JsonRecord = Record<string, unknown>;

export type RpcId = string | number;

export type PendingRpc = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export type PendingCompaction = { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export type PendingInteraction = { rpcId: RpcId; method: string; labels: string[]; questionId?: string; questionMappings?: CodexUserInputFieldMapping[]; elicitationMode?: string; elicitationApprovalPersistence?: Record<string, "session" | "always">; permissions?: unknown };

export type QueuedTurn = { text: string; attachments: MessageAttachment[]; clientMessageId?: string; visibleText: string };

export type CodexUserInputFieldMapping = { questionId: string; otherFieldId?: string; otherOptionValue?: string };

export type CodexElicitationMapping = { interaction: UserInteraction; mode: string; labels: string[]; approvalPersistence?: Record<string, "session" | "always"> };
