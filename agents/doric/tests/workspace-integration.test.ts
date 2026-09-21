import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';
import pino from 'pino';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';

import { loadBundles } from 'bundle';
import { createDockerClient } from 'docker';
import { createSandbox } from 'sandbox';
import { createSandpool } from 'sandpool';

import { createGeneration } from '../src/lib/config/generation.js';
import { createConfigService } from '../src/lib/config/service.js';
import { createConfigStore } from '../src/lib/config/store.js';
import { createWorkspaceSocket } from '../src/lib/events/socket.js';
import { registerHttpRoutes } from '../src/lib/http/app.js';
import { createVmRegistry } from '../src/lib/vms.js';
import { createProjectStore } from '../src/lib/workspace/projects.js';
import { createWorkspaceService } from '../src/lib/workspace/service.js';
import { createThreadStore } from '../src/lib/workspace/threads.js';
import type {
  InputSource,
  Project,
  Thread,
  ThreadEvent,
} from '../src/lib/workspace/types.js';
import {
  childPrompt,
  childResult,
  followup,
  marker,
  parentPrompt,
  scriptedProvider,
  secondPrompt,
} from './helpers/integration-provider.js';
import {
  cleanupStack,
  persistenceFixture,
} from './helpers/persistence-fixture.js';
import { inbox } from './helpers/socket-inbox.js';

const connectionString = process.env.DORIC_TEST_DATABASE_URL;
const enabled = connectionString && process.env.DORIC_TEST_SANDBOX === 'true';

for (const format of [
  {
    name: 'original',
    heading: '# Parent instruction',
    wrap: (json: string) => `\`\`\`text\n${json}\n\`\`\``,
  },
  {
    name: 'readable Markdown',
    heading: '## Delegated task',
    wrap: (json: string) =>
      `Tool evidence:\n\`\`\`json\n${JSON.stringify(JSON.parse(json), null, 2)}\n\`\`\``,
  },
  {
    name: 'unlabelled fence',
    heading: 'Please carry out this task:',
    wrap: (json: string) => `\`\`\`\n${json}\n\`\`\``,
  },
  { name: 'plain JSON', heading: 'Task', wrap: (json: string) => json },
]) {
  test(`scripted model accepts ${format.name} without losing tool evidence checks`, async () => {
    const provider = scriptedProvider();
    const respond = async (input: string, output?: object) => {
      const messages = [{ role: 'user' as const, content: input }];
      const events = [];
      for await (const event of provider.stream({
        model: 'fixture',
        messages:
          output === undefined
            ? messages
            : [
                ...messages,
                {
                  role: 'tool' as const,
                  toolCallId: 'fixture-call',
                  content: format.wrap(JSON.stringify(output)),
                },
              ],
      }))
        events.push(event);
      assert.equal(events.length, 1);
      const event = events[0]!;
      assert.equal(event.type, 'response.finished');
      assert.ok(event.type === 'response.finished');
      return event.finish;
    };
    const task = `${format.heading}\n\n${childPrompt}`;
    const bytes = Buffer.byteLength(`${marker}\n`);
    assert.equal((await respond(task)).toolCalls[0]?.name, 'write');
    assert.equal(
      (
        await respond(task, {
          path: 'evidence.txt',
          bytes_written: bytes,
          success: true,
        })
      ).text,
      childResult,
    );
    const result = `## Completed delegation\n\n${childResult}`;
    assert.equal((await respond(result)).toolCalls[0]?.name, 'terminal');
    assert.equal(
      (
        await respond(result, {
          stdout: { head: [marker], bytes },
          exit_code: 0,
        })
      ).text,
      'Parent verified the shared file.',
    );
    await assert.rejects(
      respond(task, { bytes_written: bytes, success: false }),
    );
    await assert.rejects(
      respond(result, { stdout: { head: [marker], bytes }, exit_code: 1 }),
    );
    await assert.rejects(
      respond(result, {
        stdout: { head: ['wrong file bytes'], bytes },
        exit_code: 0,
      }),
    );
    await assert.rejects(
      respond(result, { stdout: { head: [marker], bytes: 0 }, exit_code: 0 }),
    );
  });
}

// Build doric first to populate dist/bundles. No provider credentials are read:
// the only replaced boundary is LlmProvider; tools and all host services are real.
test(
  'delegates across isolated conversations sharing a real project sandbox and durable API events',
  {
    skip: enabled
      ? false
      : 'Requires DORIC_TEST_DATABASE_URL and DORIC_TEST_SANDBOX=true',
    timeout: 180_000,
  },
  async (t) => {
    assert.ok(connectionString);
    const cleanup = cleanupStack();
    t.after(cleanup.close);
    const resources = await persistenceFixture(connectionString);
    cleanup.defer(resources.close);
    const { database } = resources;
    const logger = pino({ level: 'silent' });
    const bundles = await loadBundles('agents/doric/dist/bundles');
    assert.ok(
      bundles
        .flatMap(({ tools }) => tools)
        .some(({ factory }) => factory.name === 'write'),
    );
    assert.ok(
      bundles
        .flatMap(({ tools }) => tools)
        .some(({ factory }) => factory.name === 'terminal'),
    );
    const config = await createConfigService({
      store: createConfigStore(database),
      bundles,
      logger,
      environment: {},
      buildGeneration: async (options) => {
        const generation = await createGeneration({
          ...options,
          environment: {},
        });
        return {
          ...generation,
          providers: new Map([
            [
              generation.snapshot.configuration.models.execution.providerId,
              scriptedProvider(),
            ],
          ]),
        };
      },
    });
    const vms = createVmRegistry('docker', createDockerClient());
    const pool = createSandpool({
      minIdle: 0,
      maxSandboxes: 1,
      maxCreateAttempts: 1,
      logger,
      create: () =>
        createSandbox({
          provider: vms.provider,
          image: 'node:22-bookworm',
          imagePullPolicy: 'if-not-present',
          resources: { cpuCount: 1, memoryMiB: 512, diskMiB: 4096 },
          network: { mode: 'disabled' },
          timeoutMs: 90_000,
        }),
    });
    cleanup.defer(() => pool.dispose());
    const projects = createProjectStore(database);
    const threads = createThreadStore(database);
    const app = express();
    const server = createServer(app);
    const sockets = new Server(server);
    cleanup.defer(
      () => new Promise<void>((resolve) => sockets.close(() => resolve())),
    );
    const service = createWorkspaceService({
      projects,
      threads,
      config,
      pool,
      logger,
      publisher: createWorkspaceSocket(sockets, projects, threads),
    });
    cleanup.defer(() => service.dispose());
    registerHttpRoutes(app, {
      config,
      service,
      vms: {
        list: vms.list,
        find: vms.find,
        ssh: service.sshForVm,
      },
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const request = async <T>(
      path: string,
      method = 'GET',
      body?: unknown,
      status = 200,
    ): Promise<T> => {
      const response = await fetch(`${base}${path}`, {
        method,
        signal: AbortSignal.timeout(10_000),
        ...(body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
      });
      assert.equal(
        response.status,
        status,
        `${method} ${path}: ${await response.clone().text()}`,
      );
      return status === 204 ? (undefined as T) : ((await response.json()) as T);
    };
    const subscribe = (
      namespace: string,
      auth: Record<string, string | number>,
    ) => {
      const socket = io(`${base}/${namespace}`, {
        transports: ['websocket'],
        reconnection: false,
        autoConnect: false,
        forceNew: true,
        auth,
      });
      cleanup.defer(async () => socket.close());
      const notices = inbox(socket);
      socket.connect();
      return notices;
    };
    const project = await request<Project>(
      '/projects',
      'POST',
      { name: 'Integration project' },
      202,
    );
    const projectSocket = subscribe('projects', { projectId: project.id });
    const snapshot = await projectSocket.wait<{
      project: Project;
      threads: Thread[];
    }>('project:snapshot');
    assert.deepEqual(snapshot.threads, []);
    if (snapshot.project.state !== 'ready') {
      await projectSocket.wait<Project>(
        'project:updated',
        (value) => value.state === 'ready',
        120_000,
      );
    }
    const root = await request<Thread>(
      `/projects/${project.id}/threads`,
      'POST',
      { name: 'Root thread' },
      201,
    );
    const rootSocket = subscribe('threads', { threadId: root.id });
    await rootSocket.wait('thread:snapshot');
    const prompt = await request<{ promptId: string }>(
      `/threads/${root.id}/prompt`,
      'POST',
      { prompt: parentPrompt },
      202,
    );
    const resumed = await rootSocket.wait<ThreadEvent>(
      'agent:event',
      (value) =>
        value.type === 'prompt.finished' &&
        completion(value).source.kind === 'result',
    );
    assert.equal(
      completion(resumed).status,
      'completed',
      JSON.stringify(await threads.eventsAfter(root.id, 0)),
    );
    assert.equal(completion(resumed).text, 'Parent verified the shared file.');
    const source = completion(resumed).source;
    assert.ok(source.kind === 'result');
    assert.equal(source.requestPromptId, prompt.promptId);
    const children = await request<{ items: Thread[] }>(
      `/projects/${project.id}/threads?parentThreadId=${root.id}`,
    );
    assert.equal(children.items.length, 1);
    const child = children.items[0]!;
    assert.equal(source.threadId, child.id);
    const childEvents = await request<{ events: ThreadEvent[] }>(
      `/threads/${child.id}/events`,
    );
    const childDone = childEvents.events.find(
      (value) => value.type === 'prompt.finished',
    );
    assert.ok(childDone);
    assert.equal(childDone.promptId, source.promptId);
    assert.deepEqual(completion(childDone).source, {
      kind: 'parent',
      threadId: root.id,
      promptId: prompt.promptId,
    });
    assert.equal(completion(childDone).status, 'completed');
    assert.ok(childEvents.events.some(({ type }) => type === 'tool.finished'));

    // REST, live delivery, and exclusive-cursor reconnect replay describe the same durable records.
    const rootEvents = await request<{ events: ThreadEvent[] }>(
      `/threads/${root.id}/events`,
    );
    assert.deepEqual(
      rootSocket.values<ThreadEvent>('agent:event'),
      rootEvents.events,
    );
    const cursor = rootEvents.events[1]!.sequence;
    const replay = subscribe('threads', {
      threadId: root.id,
      afterSequence: cursor,
    });
    const replayed = await replay.wait<{ events: ThreadEvent[] }>(
      'thread:snapshot',
    );
    const restReplay = await request<{ events: ThreadEvent[] }>(
      `/threads/${root.id}/events?afterSequence=${cursor}`,
    );
    assert.deepEqual(replayed.events, restReplay.events);
    assert.ok(
      replayed.events.every(
        (value) =>
          value.projectId === project.id &&
          value.threadId === root.id &&
          value.sequence > cursor,
      ),
    );

    const childSocket = subscribe('threads', { threadId: child.id });
    await childSocket.wait('thread:snapshot');
    const human = await request<{ promptId: string }>(
      `/threads/${child.id}/prompt`,
      'POST',
      { prompt: followup },
      202,
    );
    const humanDone = await childSocket.wait<ThreadEvent>(
      'agent:event',
      (value) =>
        value.type === 'prompt.finished' && value.promptId === human.promptId,
    );
    assert.equal(completion(humanDone).status, 'completed');
    assert.deepEqual(completion(humanDone).source, { kind: 'user' });
    // ready follows result-routing, so this is a barrier rather than a timing-based negative assertion.
    await childSocket.wait<Thread>(
      'thread:updated',
      (value) =>
        value.state === 'ready' && value.lastSequence >= humanDone.sequence,
    );
    assert.deepEqual(
      (await request<{ events: ThreadEvent[] }>(`/threads/${root.id}/events`))
        .events,
      rootEvents.events,
    );

    const sibling = await request<Thread>(
      `/projects/${project.id}/threads`,
      'POST',
      {},
      201,
    );
    const siblingSocket = subscribe('threads', { threadId: sibling.id });
    await siblingSocket.wait('thread:snapshot');
    const second = await request<{ promptId: string }>(
      `/threads/${sibling.id}/prompt`,
      'POST',
      { prompt: secondPrompt },
      202,
    );
    const secondDone = await siblingSocket.wait<ThreadEvent>(
      'agent:event',
      (value) =>
        value.type === 'prompt.finished' && value.promptId === second.promptId,
    );
    assert.equal(completion(secondDone).status, 'completed');
    assert.equal(
      completion(secondDone).text,
      'Independent root verified the shared file.',
    );
    assert.equal(pool.status().leased, 1);
    const rootHistory = (await threads.find(root.id))!.messages;
    const childHistory = (await threads.find(child.id))!.messages;
    const siblingHistory = (await threads.find(sibling.id))!.messages;
    assert.ok(JSON.stringify(rootHistory).includes(parentPrompt));
    assert.ok(!JSON.stringify(rootHistory).includes(followup));
    assert.ok(JSON.stringify(childHistory).includes(followup));
    assert.ok(!JSON.stringify(childHistory).includes(parentPrompt));
    assert.ok(!JSON.stringify(siblingHistory).includes(parentPrompt));
    assert.ok(!JSON.stringify(siblingHistory).includes(followup));

    await request(`/projects/${project.id}/terminate`, 'POST', {});
    await projectSocket.wait<Project>(
      'project:updated',
      (value) => value.state === 'cancelled',
    );
    assert.equal(pool.status().leased, 0);
    for (const thread of [root, child, sibling]) {
      assert.equal(
        (await request<Thread>(`/threads/${thread.id}`)).state,
        'cancelled',
      );
    }
    await request(`/projects/${project.id}`, 'DELETE', undefined, 204);
    assert.equal(await projects.find(project.id), undefined);
    for (const thread of [root, child, sibling]) {
      assert.equal(await threads.find(thread.id), undefined);
      assert.deepEqual(await threads.eventsAfter(thread.id, 0), []);
    }
  },
);

type Completion = { status: string; text: string; source: InputSource };
const completion = (event: ThreadEvent) => event.event as Completion;
