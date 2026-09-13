import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { client, methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

import { acp } from '../src/acp.mjs';
import { createEventPublisher } from '../src/events.mjs';
import { startGateway } from '../src/gateway.mjs';
import { workspace } from '../src/workspace.mjs';

test('gateway acknowledges retrieval evidence only after it is written on the host', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'benchmark-evidence-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const eventsPath = join(root, 'events.jsonl');

  const gateway = await startGateway({
    archive: join(root, 'unused'),
    eventsPath,
    token: 'temporary',
    apiKey: 'unused',
    models: [],
    host: '127.0.0.1',
    fetcher: () => {
      throw new Error('Events must not reach the provider.');
    },
  });

  t.after(() => gateway.close());

  const event = {
    runId: 'test-run',
    sequence: 1,
    agent: 'direct',
    stage: 'retrieval.p0.1',
    at: '2026-09-12T00:00:00Z',
    data: { ranked: [{ name: 'jax-skills', score: 0.9 }] },
  };
  const url = 'http://127.0.0.1:' + gateway.port + '/api/v1/events';

  const post = (token) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token },
      body: JSON.stringify(event),
    });

  assert.equal((await post('wrong')).status, 401);

  assert.equal((await post('temporary')).status, 204);

  assert.deepEqual(
    JSON.parse((await readFile(eventsPath, 'utf8')).trim()),
    event,
  );

  assert.equal(gateway.usage.length, 0);
});

test('event publisher rejects failed host writes instead of losing evidence silently', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'benchmark-evidence-failure-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const gateway = await startGateway({
    archive: join(root, 'unused'),
    eventsPath: root,
    token: 'temporary',
    apiKey: 'unused',
    models: [],
    host: '127.0.0.1',
  });

  t.after(() => gateway.close());

  const publish = createEventPublisher({
    baseUrl: 'http://127.0.0.1:' + gateway.port + '/api/v1',
    apiKey: 'temporary',
  });

  await assert.rejects(
    publish({
      runId: 'test',
      sequence: 1,
      agent: 'direct',
      stage: 'run.started',
      at: 'now',
      data: {},
    }),
  );
});

test('tools write and read artifacts in the supplied task workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'benchmark-workspace-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const tools = workspace(root);

  await tools.writeFile('nested/result.txt', 'done');

  const result = await tools.exec({ cmd: ['cat', 'nested/result.txt'] });

  assert.equal(result.exitCode, 0);

  assert.equal(result.stdout, 'done');

  assert.equal(await tools.readFile('nested/result.txt'), 'done');
});

test('cancellation stops a running task command', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'benchmark-cancel-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const controller = new AbortController();

  const result = workspace(root, controller.signal).exec({
    cmd: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
  });

  controller.abort();

  assert.equal((await result).exitCode, 124);
});

test('gateway authenticates calls, restricts models and preserves unknown cost', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'benchmark-gateway-'));

  t.after(() => rm(root, { recursive: true, force: true }));

  const archive = join(root, 'agent.tar.gz');

  await writeFile(archive, 'archive');

  const gateway = await startGateway({
    archive,
    token: 'temporary',
    apiKey: 'host-secret',
    models: ['chosen'],
    host: '127.0.0.1',
    fetcher: async (_url, request) => {
      assert.equal(request.headers.authorization, 'Bearer host-secret');

      return Response.json({ data: [{ embedding: [1, 0] }] });
    },
  });

  t.after(() => gateway.close());

  const url = 'http://127.0.0.1:' + gateway.port;

  assert.equal(await (await fetch(url + '/agent.tar.gz')).text(), 'archive');

  const post = (token, model) =>
    fetch(url + '/api/v1/embeddings', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token },
      body: JSON.stringify({ model, input: 'text' }),
    });

  assert.equal((await post('wrong', 'chosen')).status, 401);

  assert.equal((await post('temporary', 'other')).status, 400);

  assert.equal((await post('temporary', 'chosen')).status, 200);

  assert.equal(gateway.usage[0].usage, null);

  assert.equal(JSON.stringify(gateway.usage).includes('host-secret'), false);
});

test('ACP forwards the task prompt, workspace and final answer', async () => {
  const updates = [];

  const application = acp({
    mode: 'direct',
    createRunner: () => ({
      run: async (request, emit) => {
        assert.equal(request.cwd, '/app');

        assert.equal(request.prompt, 'Task\nConstraints');

        await emit({ type: 'message_delta', delta: 'Completed' });
      },
    }),
  });

  const consumer = client({ name: 'benchmark-test' }).onNotification(
    methods.client.session.update,
    ({ params }) => {
      updates.push(params.update);
    },
  );

  await consumer.connectWith(application, async (context) => {
    await context.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
    });

    const { sessionId } = await context.request(methods.agent.session.new, {
      cwd: '/app',
      mcpServers: [],
    });

    const result = await context.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [
        { type: 'text', text: 'Task' },
        { type: 'text', text: 'Constraints' },
      ],
    });

    assert.equal(result.stopReason, 'end_turn');

    assert.equal(updates.at(-1).content.text, 'Completed');
  });
});

test('ACP does not disclose provider failure details', async () => {
  const application = acp({
    mode: 'mosaic',
    createRunner: () => ({
      run: async () => {
        throw new Error('private-provider-key');
      },
    }),
  });

  await client({ name: 'benchmark-test' }).connectWith(
    application,
    async (context) => {
      await context.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
      });

      const { sessionId } = await context.request(methods.agent.session.new, {
        cwd: '/app',
        mcpServers: [],
      });

      await assert.rejects(
        context.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'Task' }],
        }),
        (error) =>
          error.code === -32603 &&
          !JSON.stringify(error).includes('private-provider-key'),
      );
    },
  );
});
