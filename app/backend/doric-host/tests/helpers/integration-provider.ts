import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';

export const marker = 'written by the delegated child';
export const parentPrompt =
  'Delegate the file task. Parent-only context: orange.';
export const childPrompt = 'Write the shared evidence file.';
export const followup = 'Human-only child followup: violet.';
export const secondPrompt =
  'Read the shared evidence in this independent root.';
export const childResult = 'Child wrote the shared evidence file.';

/** The model every scripted request names, as the catalog lists it. */
export const scriptedModel = 'fixture/model';

interface ChatMessage {
  readonly role: string;
  readonly content?: unknown;
}

/** What the script answers one model turn: a text, or one tool call. */
type Turn =
  | { readonly text: string }
  | { readonly call: string; readonly args: unknown };

/**
 * Only the external LLM is scripted, and the assertions require actual tool
 * evidence: a turn that follows a tool result checks what the tool did.
 */
/** A prompt the script answers once a first request for it was held. */
export const heldPrompt = 'Answer after the host lost this request.';
export const heldAnswer = 'Answered after the generation came back.';

export const scriptedTurn = (messages: readonly ChatMessage[]): Turn => {
  const input = messages.filter(({ role }) => role === 'user').at(-1)?.content;
  if (typeof input !== 'string') throw new Error('Expected a text prompt');
  if (input.includes(heldPrompt)) return { text: heldAnswer };
  const tool = messages.at(-1);
  if (tool?.role === 'tool') {
    // The fixture has one JSON result; surrounding readable Markdown is presentation.
    const content = tool.content;
    if (typeof content !== 'string')
      throw new Error('Expected a text tool result');
    const output = JSON.parse(
      content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1),
    ) as {
      success?: boolean;
      bytes_written?: number;
      exit_code?: number;
      stdout?: { head: string[]; bytes: number };
    };
    if (input.includes(parentPrompt))
      return { text: 'Delegated; awaiting child evidence.' };
    if (input.includes(childPrompt)) {
      assert.equal(output.success, true);
      assert.equal(output.bytes_written, Buffer.byteLength(`${marker}\n`));
      return { text: childResult };
    }
    assert.equal(output.exit_code, 0);
    assert.deepEqual(output.stdout?.head, [marker]);
    assert.equal(output.stdout?.bytes, Buffer.byteLength(`${marker}\n`));
    return {
      text: input.includes(childResult)
        ? 'Parent verified the shared file.'
        : 'Independent root verified the shared file.',
    };
  }
  if (input.includes(childResult))
    return {
      call: 'terminal',
      args: { command: 'cat evidence.txt', timeout_ms: 5000 },
    };
  if (input.includes(childPrompt)) {
    assert.ok(!JSON.stringify(messages).includes(parentPrompt));
    return {
      call: 'write',
      args: { path: 'evidence.txt', content: `${marker}\n` },
    };
  }
  if (input.includes(followup))
    return { text: 'Answered the human in the child only.' };
  if (input.includes(secondPrompt)) {
    assert.ok(!JSON.stringify(messages).includes(parentPrompt));
    return {
      call: 'terminal',
      args: { command: 'cat evidence.txt', timeout_ms: 5000 },
    };
  }
  assert.ok(input.includes(parentPrompt), `Unexpected input: ${input}`);
  return { call: 'thread-spawn', args: { prompt: childPrompt } };
};

const body = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

/**
 * The scripted model behind an OpenRouter-kind endpoint (`<url>/v1`): the
 * catalog at `/v1/models` and streamed Chat Completions at
 * `/v1/chat/completions`. It records every chat request body, and answers a
 * turn the script refuses with a 500 so the run fails visibly.
 */
export const scriptedEndpoint = async () => {
  const requests: { readonly messages: readonly ChatMessage[] }[] = [];
  const failures: string[] = [];
  /** The first request for `heldPrompt` is never answered. */
  let held = false;
  let onHeld: () => void = () => undefined;
  const firstHeld = new Promise<void>((resolve) => {
    onHeld = resolve;
  });
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            data: [
              {
                id: scriptedModel,
                name: 'Fixture',
                context_length: 128000,
                supported_parameters: ['tools', 'tool_choice', 'max_tokens'],
              },
            ],
          }),
        );
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(await body(request)) as {
        readonly model: string;
        readonly messages: readonly ChatMessage[];
      };
      requests.push({ messages: parsed.messages });
      if (!held && JSON.stringify(parsed.messages).includes(heldPrompt)) {
        held = true;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(': held\n\n');
        onHeld();
        return;
      }
      let turn: Turn;
      try {
        turn = scriptedTurn(parsed.messages);
      } catch (error) {
        failures.push(String(error));
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'script refused' } }));
        return;
      }
      const id = `gen-${randomUUID()}`;
      const chunk = (delta: unknown, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          model: parsed.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      response.write(chunk({ role: 'assistant', content: '' }));
      if ('text' in turn) {
        response.write(chunk({ content: turn.text }));
        response.write(chunk({}, 'stop'));
      } else {
        response.write(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `call_${randomUUID().replaceAll('-', '')}`,
                type: 'function',
                function: {
                  name: turn.call,
                  arguments: JSON.stringify(turn.args),
                },
              },
            ],
          }),
        );
        response.write(chunk({}, 'tool_calls'));
      }
      response.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          model: parsed.model,
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');

  return {
    endpoint: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    failures,
    /** Resolves once the first request for `heldPrompt` arrived and is held. */
    held: firstHeld,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
