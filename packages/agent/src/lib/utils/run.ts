import type { JsonValue, ProviderFinished } from 'llms';
import { AgentErrorObject } from '../classes/agent-error.js';

import type {
  AgentResponse,
  AgentRunOptions,
  AgentStructuredAttemptEvent,
  AgentToolCallRepairEvent,
  AgentToolEvent,
} from '../types/agent.js';
import type { ToolCallRecord } from '../types/tool-call-storage.js';

const defaultMaxToolCallRepairs = 2;

export const turnGuard = (maxTurns: number | undefined): (() => void) => {
  if (
    maxTurns !== undefined &&
    (!Number.isSafeInteger(maxTurns) || maxTurns <= 0)
  ) {
    throw new TypeError('Agent maxTurns must be a positive safe integer.');
  }

  let turns = 0;
  return (): void => {
    if (maxTurns !== undefined && turns >= maxTurns) {
      throw new AgentErrorObject({
        code: 'turn_limit_exceeded',
        message: `Agent exceeded its ${maxTurns}-turn limit.`,
      });
    }
    turns += 1;
  };
};

export const repairLimit = (value: number | undefined): number => {
  const limit = value ?? defaultMaxToolCallRepairs;

  if (Number.isSafeInteger(limit) && limit >= 0) return limit;
  throw new TypeError(
    'Agent maxToolCallRepairs must be a non-negative safe integer.',
  );
};

export const toolCallCorrection = [
  '# Tool call correction',
  '',
  'The previous tool-call response was rejected before any tool ran.',
  'Call only available tools and pass valid JSON arguments matching their schemas.',
].join('\n');

export const pushIncompleteToolResults = (
  finish: ProviderFinished<unknown>,
  push: (callId: string, content: string, status: 'incomplete') => void,
): void => {
  for (const call of finish.toolCalls) {
    push(
      call.id,
      'Tool call rejected before execution. Correct the call and try again.',
      'incomplete',
    );
  }
};

export const notifyToolCallRepair = async <Output>(
  options: AgentRunOptions<Output>,
  event: Omit<AgentToolCallRepairEvent, 'schemaVersion'>,
): Promise<void> => {
  await options.onToolCallRepair?.({ schemaVersion: 1, ...event });
};

export const notifyStructuredAttempt = async <Output>(
  options: AgentRunOptions<Output>,
  event: Omit<AgentStructuredAttemptEvent, 'schemaVersion'>,
): Promise<void> => {
  await options.onStructuredAttempt?.({ schemaVersion: 1, ...event });
};

export const notifyToolEvent = async <Output>(
  options: AgentRunOptions<Output>,
  event: AgentToolEvent,
): Promise<void> => {
  await options.onToolEvent?.(event);
};

export const toolResultEnvelope = (record: ToolCallRecord): string =>
  [
    '# Tool Result',
    '',
    '## Observation ID',
    '',
    fenced(record.id),
    '',
    '## Output',
    '',
    fenced(record.output),
  ].join('\n');

const fenced = (value: string): string => {
  const longest = Math.max(
    0,
    ...[...value.matchAll(/`+/gu)].map(([run]) => run.length),
  );
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const body = value.endsWith('\n') ? value : `${value}\n`;
  return `${fence}text\n${body}${fence}`;
};

export const responseFromFinish = <Output = JsonValue>(
  finish: ProviderFinished<Output>,
): AgentResponse<Output> => ({
  text: finish.text,
  finishReason: finish.finishReason,
  usage: finish.usage,
  reasoning: finish.reasoning,
  refusal: finish.refusal,
  structured: finish.structured,
  finish,
});
