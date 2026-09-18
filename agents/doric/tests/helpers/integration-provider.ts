import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { LlmProvider, ProviderRequest } from 'llms';

export const marker = 'written by the delegated child';
export const parentPrompt =
  'Delegate the file task. Parent-only context: orange.';
export const childPrompt = 'Write the shared evidence file.';
export const followup = 'Human-only child followup: violet.';
export const secondPrompt =
  'Read the shared evidence in this independent root.';
export const childResult = 'Child wrote the shared evidence file.';

const finished = (text: string) => ({
  type: 'response.finished' as const,
  finish: { text, finishReason: 'stop' as const, toolCalls: [] },
});
const call = (name: string, args: unknown) => ({
  type: 'response.finished' as const,
  finish: {
    text: '',
    finishReason: 'tool_calls' as const,
    toolCalls: [{ id: randomUUID(), name, arguments: JSON.stringify(args) }],
  },
});

/** Only the external LLM is scripted; assertions require actual tool evidence. */
export function scriptedProvider(): LlmProvider {
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected provider operation');
  };
  return {
    metadata: {
      id: 'integration',
      name: 'integration',
      baseUrl: 'http://unused.invalid',
    },
    capabilities: {
      streaming: true,
      embeddings: false,
      reranking: false,
      tools: true,
      reasoning: false,
      modelListing: false,
      oauth: false,
      serviceTier: false,
      structuredOutputs: false,
    },
    complete: unused,
    embedding: unused,
    rerank: unused,
    models: unused,
    validateModel: unused,
    stream: async function* (request: ProviderRequest) {
      const input = String(
        request.messages.filter(({ role }) => role === 'user').at(-1)?.content,
      );
      const tool = request.messages.at(-1);
      if (tool?.role === 'tool') {
        // The fixture has one JSON result; surrounding readable Markdown is presentation.
        const content = String(tool.content);
        const output = JSON.parse(
          content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1),
        ) as {
          success?: boolean;
          bytes_written?: number;
          exit_code?: number;
          stdout?: { head: string[]; bytes: number };
        };
        if (input.includes(parentPrompt)) {
          yield finished('Delegated; awaiting child evidence.');
        } else if (input.includes(childPrompt)) {
          assert.equal(output.success, true);
          assert.equal(output.bytes_written, Buffer.byteLength(`${marker}\n`));
          yield finished(childResult);
        } else {
          assert.equal(output.exit_code, 0);
          assert.deepEqual(output.stdout?.head, [marker]);
          assert.equal(output.stdout?.bytes, Buffer.byteLength(`${marker}\n`));
          yield finished(
            input.includes(childResult)
              ? 'Parent verified the shared file.'
              : 'Independent root verified the shared file.',
          );
        }
      } else if (input.includes(childResult)) {
        yield call('terminal', {
          command: 'cat evidence.txt',
          timeout_ms: 5000,
        });
      } else if (input.includes(childPrompt)) {
        assert.ok(!JSON.stringify(request.messages).includes(parentPrompt));
        yield call('write', { path: 'evidence.txt', content: `${marker}\n` });
      } else if (input.includes(followup)) {
        yield finished('Answered the human in the child only.');
      } else if (input.includes(secondPrompt)) {
        assert.ok(!JSON.stringify(request.messages).includes(parentPrompt));
        yield call('terminal', {
          command: 'cat evidence.txt',
          timeout_ms: 5000,
        });
      } else {
        assert.ok(input.includes(parentPrompt), `Unexpected input: ${input}`);
        yield call('spawn_thread', { prompt: childPrompt });
      }
    },
  };
}
