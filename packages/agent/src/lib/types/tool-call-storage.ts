import type { ToolCall } from 'tool';

/** One successfully serialized executable-tool result owned by an agent. */
export interface ToolCallRecord {
  readonly id: string;
  readonly callId: string;
  readonly toolName: string;
  readonly input: string;
  readonly output: string;
}

/** Process-local append-only ledger of successful executable-tool results. */
export interface ToolCallStorage {
  append(call: ToolCall, output: string): ToolCallRecord;

  list(): readonly ToolCallRecord[];
}

export interface ToolCallStorageOptions {
  readonly createId?: () => string;
}
