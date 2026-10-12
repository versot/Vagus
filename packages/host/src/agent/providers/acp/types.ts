import { CreateElicitationRequest, type ClientConnection, type CreateElicitationResponse } from "@agentclientprotocol/sdk";
import type { BrowserElementReference, MessageAttachment } from "@vagus/protocol";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type AcpRecord = Record<string, any>;

export type PendingPermission = { resolve: (optionId: string | null) => void; options: Array<{ optionId: string; label: string; kind: string }> };

export type PendingElicitation = { resolve: (response: CreateElicitationResponse) => void; params: CreateElicitationRequest };

export type PendingAcpPrompt = { text: string; attachments: MessageAttachment[]; browserElements: BrowserElementReference[]; clientMessageId?: string };

export type AcpRuntime = { child: ChildProcessWithoutNullStreams; connection: ClientConnection; capabilities: AcpRecord };
