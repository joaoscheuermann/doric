import type { ToolCall } from 'tool';
import type {
  AgentOptions,
  AgentRunOptions,
  AgentToolEvent,
} from '../types/agent.js';
import type { ToolCallRecord } from '../types/tool-call-storage.js';
import { notifyToolEvent } from './run.js';
import { serializeToolResult } from './serialize.js';

/** Active handlers finish cooperatively; cancellation prevents further starts. */
export async function* runTools<Output>(
  options: AgentOptions,
  calls: readonly ToolCall[],
  runOptions: AgentRunOptions<Output>,
  pushResult: (record: ToolCallRecord) => string,
): AsyncGenerator<AgentToolEvent> {
  for (const call of calls) {
    runOptions.signal?.throwIfAborted();
    const started = { type: 'tool.started' as const, call };
    await notifyToolEvent(runOptions, started);
    runOptions.signal?.throwIfAborted();
    yield started;
    runOptions.signal?.throwIfAborted();

    let finished: Extract<AgentToolEvent, { type: 'tool.finished' }>;
    try {
      const result = await options.tools.execute(call);
      const output = serializeToolResult(result);
      const record = options.toolCalls.append(call, output);
      const content = pushResult(record);
      finished = { type: 'tool.finished', call, result, content, record };
    } catch (error) {
      const failed = { type: 'tool.failed' as const, call, error };
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
