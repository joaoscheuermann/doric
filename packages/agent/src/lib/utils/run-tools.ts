import type { ToolCall } from 'tool';

import type {
  AgentOptions,
  AgentRunOptions,
  AgentToolEvent,
} from '../types/agent.js';
import type { ToolCallRecord } from '../types/tool-call-storage.js';
import { notifyToolEvent } from './run.js';
import { serializeToolResult } from './serialize.js';

type ToolFailedEvent = Extract<AgentToolEvent, { type: 'tool.failed' }>;

/**
 * Active handlers finish cooperatively; cancellation prevents further starts.
 *
 * A handler that throws does not end the run: its failure becomes the call's
 * result, so the model reads why the call failed and decides what to do, and
 * the batch goes on. Only a run already cancelled ends with the handler's
 * error, as does a failure of the loop's own bookkeeping (serializing or
 * recording a result).
 */
export async function* runTools<Output>(
  options: AgentOptions,
  calls: readonly ToolCall[],
  runOptions: AgentRunOptions<Output>,
  pushResult: (record: ToolCallRecord) => string,
  pushFailure: (call: ToolCall, error: unknown) => void,
): AsyncGenerator<AgentToolEvent> {
  for (const call of calls) {
    runOptions.signal?.throwIfAborted();
    const started = { type: 'tool.started' as const, call };
    await notifyToolEvent(runOptions, started);
    runOptions.signal?.throwIfAborted();
    yield started;
    runOptions.signal?.throwIfAborted();

    let result: unknown;
    try {
      result = await options.tools.execute(call);
    } catch (error) {
      const failed: ToolFailedEvent = { type: 'tool.failed', call, error };

      if (runOptions.signal?.aborted) {
        await notifyToolEvent(runOptions, failed);
        yield failed;
        throw error;
      }

      // The answer is stored before the callback, as a finished call's is, so
      // a callback error never leaves the call unanswered.
      pushFailure(call, error);
      await notifyToolEvent(runOptions, failed);
      runOptions.signal?.throwIfAborted();
      yield failed;
      runOptions.signal?.throwIfAborted();
      continue;
    }

    let finished: Extract<AgentToolEvent, { type: 'tool.finished' }>;
    try {
      const output = serializeToolResult(result);
      const record = options.toolCalls.append(call, output);
      const content = pushResult(record);
      finished = { type: 'tool.finished', call, result, content, record };
    } catch (error) {
      const failed: ToolFailedEvent = { type: 'tool.failed', call, error };
      await notifyToolEvent(runOptions, failed);
      yield failed;
      throw error;
    }
    // Callback errors belong to the caller, not the completed tool execution.
    await notifyToolEvent(runOptions, finished);
    runOptions.signal?.throwIfAborted();
    yield finished;
    runOptions.signal?.throwIfAborted();
  }
}
