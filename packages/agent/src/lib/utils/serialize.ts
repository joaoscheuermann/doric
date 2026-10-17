import { isRecord } from 'tool';

import { AgentErrorObject } from '../classes/agent-error.js';

/** The most levels of a failure's cause chain the model reads. */
const MAX_FAILURE_CAUSES = 8;

/** A level's own code: `ContractError.code`, else a tool or agent error's `data.code`. */
const codeOf = (error: Error): string | undefined => {
  const code: unknown = Reflect.get(error, 'code');
  if (typeof code === 'string') return code;

  const data: unknown = Reflect.get(error, 'data');
  const nested = isRecord(data) ? data.code : undefined;

  return typeof nested === 'string' ? nested : undefined;
};

const messageOf = (value: unknown): string => {
  if (value instanceof Error) return value.message.trim() || value.name;
  if (typeof value === 'string') return value;

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/**
 * The text of a call whose handler threw: what it threw and each cause under
 * it, one per line, outermost first, each with its code when it has one. The
 * tool registry's `handler_failed` wrapper only says that the handler threw,
 * so the chain starts at what the handler threw. A cause whose message an
 * outer line already quotes adds nothing and is left out.
 */
export const describeToolFailure = (error: unknown): string => {
  const wrapped =
    error instanceof Error &&
    codeOf(error) === 'handler_failed' &&
    error.cause !== undefined;
  const lines: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = wrapped ? error.cause : error;

  for (
    let depth = 0;
    depth < MAX_FAILURE_CAUSES && current !== undefined && !seen.has(current);
    depth += 1
  ) {
    seen.add(current);
    const message = messageOf(current);

    if (message !== '' && !lines.some((line) => line.includes(message))) {
      const code = current instanceof Error ? codeOf(current) : undefined;
      const line = code === undefined ? message : `${code}: ${message}`;
      lines.push(lines.length === 0 ? line : `Caused by: ${line}`);
    }

    current = current instanceof Error ? current.cause : undefined;
  }

  return lines.length === 0
    ? 'The tool failed without a message.'
    : lines.join('\n');
};

export const serializeToolResult = (result: unknown): string => {
  if (typeof result === 'string') {
    return result;
  }

  if (result === undefined) {
    return '';
  }

  try {
    const content = JSON.stringify(result);

    if (content !== undefined) {
      return content;
    }
  } catch (cause) {
    throw new AgentErrorObject(
      {
        code: 'tool_result_serialization_failed',
        message: 'Tool result could not be serialized to JSON.',
      },
      { cause },
    );
  }

  throw new AgentErrorObject({
    code: 'tool_result_serialization_failed',
    message: 'Tool result could not be serialized to JSON.',
  });
};
