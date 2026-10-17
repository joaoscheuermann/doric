import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const script = new URL('../spawn-agent.mjs', import.meta.url);

for (const [outcome, terminate] of [
  ['completed', true],
  ['failed', true],
  ['cancelled', true],
  ['completed', false],
  ['thread-rejected', true],
  ['prompt-rejected', true],
]) {
  test(`handles ${outcome} with termination ${terminate}`, async (t) => {
    const requests = [];
    let replay = 0;
    const server = createServer(async (request, response) => {
      let text = '';
      for await (const chunk of request) text += chunk;
      const body = text ? JSON.parse(text) : undefined;
      requests.push({ method: request.method, path: request.url, body });
      response.setHeader('content-type', 'application/json');
      const values = {
        'POST /projects': { id: 'project-1' },
        'POST /projects/project-1/threads': { id: 'thread-1' },
        'POST /threads/thread-1/prompt': { promptId: 'prompt-1' },
        'GET /threads/thread-1': { state: 'running' },
        'POST /projects/project-1/terminate': { state: 'cancelled' },
      };
      const key = `${request.method} ${request.url}`;
      if (
        (outcome === 'thread-rejected' &&
          key === 'POST /projects/project-1/threads') ||
        (outcome === 'prompt-rejected' &&
          key === 'POST /threads/thread-1/prompt')
      ) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: 'never-print-event-payload' }));
        return;
      }
      if (
        request.method === 'GET' &&
        /^\/threads\/thread-1\/events\?afterSequence=\d+$/.test(request.url)
      ) {
        replay += 1;
        response.end(
          JSON.stringify({
            events: [
              {
                projectId: 'project-1',
                threadId: 'thread-1',
                promptId: replay === 2 ? 'unrelated-prompt' : 'prompt-1',
                sequence: replay,
                type: replay === 1 ? 'agent.finished' : 'prompt.finished',
                event: { status: outcome, secret: 'never-print-event-payload' },
              },
            ],
            lastSequence: replay,
          }),
        );
        return;
      }
      if (!(key in values)) response.statusCode = 404;
      response.end(JSON.stringify(values[key] ?? {}));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();
    const args = [
      script.pathname,
      '--url',
      `http://127.0.0.1:${address.port}`,
      '--prompt',
      'private human input',
      ...(terminate ? ['--terminate'] : []),
    ];
    let result;
    try {
      result = await execute(process.execPath, args, { timeout: 5000 });
      assert.equal(outcome, 'completed');
    } catch (error) {
      assert.notEqual(outcome, 'completed');
      assert.equal(error.code, 1);
      result = error;
    }
    const expectedCreation = [
      {
        method: 'POST',
        path: '/projects',
        body: { name: 'spawn-agent project' },
      },
      {
        method: 'POST',
        path: '/projects/project-1/threads',
        body: { name: 'spawn-agent root' },
      },
      {
        method: 'POST',
        path: '/threads/thread-1/prompt',
        body: { prompt: 'private human input' },
      },
    ];
    assert.deepEqual(
      requests.slice(0, outcome === 'thread-rejected' ? 2 : 3),
      expectedCreation.slice(0, outcome === 'thread-rejected' ? 2 : 3),
    );
    if (!outcome.endsWith('-rejected')) {
      assert.ok(
        requests.some(
          ({ method, path }) =>
            method === 'GET' &&
            path === '/threads/thread-1/events?afterSequence=2',
        ),
      );
      assert.equal(replay, 3);
    }
    const cleanup = requests.filter(
      ({ path }) => path === '/projects/project-1/terminate',
    );
    assert.deepEqual(
      cleanup,
      terminate
        ? [{ method: 'POST', path: '/projects/project-1/terminate', body: {} }]
        : [],
    );
    assert.match(result.stdout, /projects\/project-1\/ssh/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /never-print-event-payload|private human input/,
    );
    for (const line of result.stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))) {
      assert.ok(
        Object.keys(JSON.parse(line)).every((key) =>
          [
            'projectId',
            'threadId',
            'promptId',
            'sequence',
            'type',
            'ssh',
            'terminationRequested',
          ].includes(key),
        ),
      );
    }
  });
}

test('shows the REST client help without requiring credentials', async () => {
  const result = await execute(process.execPath, [script.pathname, '--help']);
  assert.match(result.stdout, /--terminate/);
});
