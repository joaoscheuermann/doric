import { randomUUID } from 'node:crypto';

import type { ToolCall } from 'tool';

import { AgentErrorObject } from './classes/agent-error.js';
import type {
  ToolCallRecord,
  ToolCallStorage,
  ToolCallStorageOptions,
} from './types/tool-call-storage.js';

/** Creates an isolated in-memory ledger with opaque IDs for successful tool results. */
export const createToolCallStorage = (
  options: ToolCallStorageOptions = {},
): ToolCallStorage => {
  const createId = options.createId ?? randomUUID;
  const records: ToolCallRecord[] = [];
  const ids = new Set<string>();

  return {
    append: (call, output) => {
      const id = createId();

      validateId(id, ids);

      const record = Object.freeze({
        id,
        callId: call.id,
        toolName: call.name,
        input: serializeInput(call),
        output,
      });

      ids.add(id);

      records.push(record);

      return record;
    },
    list: () => [...records],
  };
};

const validateId = (id: string, ids: ReadonlySet<string>): void => {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new AgentErrorObject({
      code: 'tool_call_id_invalid',
      message: 'Tool call storage produced an empty observation ID.',
    });
  }

  if (ids.has(id)) {
    throw new AgentErrorObject({
      code: 'tool_call_id_collision',
      message: 'Tool call storage produced a duplicate observation ID.',
    });
  }
};

const serializeInput = (call: ToolCall): string => {
  try {
    const input = JSON.stringify(call.payload);

    if (input !== undefined) {
      return input;
    }
  } catch (cause) {
    throw new AgentErrorObject(
      {
        code: 'tool_input_serialization_failed',
        message: 'Tool input could not be serialized to JSON.',
      },
      { cause },
    );
  }

  throw new AgentErrorObject({
    code: 'tool_input_serialization_failed',
    message: 'Tool input could not be serialized to JSON.',
  });
};
