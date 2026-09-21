import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProviderRequest } from 'llms';

import type { ConfigService } from '../src/lib/config/service.js';
import { createWorkspaceService } from '../src/lib/workspace/service.js';
import { deferred, pool, workspace } from './helpers/workspace.js';

const finish = (text: string) => ({
  type: 'response.finished' as const,
  finish: { text, finishReason: 'stop' as const, toolCalls: [] },
});

test(
  'executes delegated work through real Direct tools and resumes the parent automatically',
  { timeout: 5000 },
  async () => {
    const harness = workspace();
    const resumed = deferred();
    const requests: ProviderRequest[] = [];
    const generation = (harness.dependencies.config as ConfigService).current();
    const provider = {
      metadata: { id: 'local', name: 'local' },
      stream: async function* (request: ProviderRequest) {
        requests.push(request);
        const input = String(
          request.messages.filter(({ role }) => role === 'user').at(-1)
            ?.content,
        );
        if (input.startsWith('# Child result')) {
          assert.match(input, /child evidence/u);
          resumed.resolve();
          yield finish('Consolidated result.');
        } else if (input.startsWith('# Parent instruction')) {
          yield finish('child evidence');
        } else if (request.messages.at(-1)?.role === 'tool') {
          yield finish('Delegated; awaiting result.');
        } else {
          yield {
            type: 'response.finished' as const,
            finish: {
              text: '',
              finishReason: 'tool_calls' as const,
              toolCalls: [
                {
                  id: 'spawn-1',
                  name: 'spawn_thread',
                  arguments: JSON.stringify({
                    prompt: 'Investigate child task.',
                  }),
                },
              ],
            },
          };
        }
      },
    };
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: pool(),
      config: {
        current: () => ({
          ...generation,
          providers: new Map([
            [
              generation.snapshot.configuration.models.execution.providerId,
              provider,
            ],
          ]),
        }),
      } as never,
    });
    const project = await service.projects.create('Project');
    const created = await service.threads.create(project.id, 'Thread');
    assert.ok(created.status === 'created');
    await service.threads.prompt(
      created.thread.id,
      'Delegate the investigation.',
    );
    await resumed.promise;
    await harness.threadState(created.thread.id, 'ready');
    const children = await service.threads.list(
      project.id,
      100,
      undefined,
      created.thread.id,
    );
    assert.equal(children?.items.length, 1);
    assert.ok(
      requests.some((request) =>
        request.tools?.some((tool) => tool.name === 'spawn_thread'),
      ),
    );
    const events = await service.threads.events(created.thread.id, 0);
    assert.ok(events?.events.some(({ type }) => type === 'tool.finished'));
    assert.ok(
      events?.events.some(
        ({ event }) =>
          (event as { source?: { kind: string } }).source?.kind === 'result',
      ),
    );
    await service.dispose();
  },
);

test(
  'stops queued execution when Direct cannot persist its resulting history',
  { timeout: 5000 },
  async () => {
    const harness = workspace();
    const started = deferred();
    const release = deferred();
    const generation = (harness.dependencies.config as ConfigService).current();
    let invocations = 0;
    let failSave = true;
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: pool(),
      threads: {
        ...harness.threads,
        saveMessages: async (id, messages) => {
          if (failSave) {
            failSave = false;
            throw new Error('database unavailable');
          }
          await harness.threads.saveMessages(id, messages);
        },
      },
      config: {
        current: () => ({
          ...generation,
          providers: new Map([
            [
              generation.snapshot.configuration.models.execution.providerId,
              {
                metadata: { id: 'local', name: 'local' },
                stream: async function* () {
                  invocations += 1;
                  started.resolve();
                  await release.promise;
                  yield finish('Result with effects already performed.');
                },
              },
            ],
          ]),
        }),
      } as never,
    });
    const project = await service.projects.create('Project');
    const created = await service.threads.create(project.id, 'Thread');
    assert.ok(created.status === 'created');
    await service.threads.prompt(created.thread.id, 'first');
    await started.promise;
    await service.threads.prompt(
      created.thread.id,
      'must not run with stale history',
    );
    release.resolve();
    await harness.threadState(created.thread.id, 'failed');
    assert.equal(invocations, 1);
    assert.equal(
      (await service.threads.prompt(created.thread.id, 'retry')).status,
      'inactive',
    );
    await service.dispose();
  },
);

test(
  'releases the sandbox despite transient cancellation persistence failures',
  { timeout: 5000 },
  async () => {
    const harness = workspace();
    const started = deferred();
    let releases = 0;
    let rejectProject = true;
    let rejectThread = true;
    const service = createWorkspaceService({
      ...harness.dependencies,
      projects: {
        ...harness.projects,
        setState: async (id, state, code) => {
          if (state === 'cancelling' && rejectProject) {
            rejectProject = false;
            throw new Error('database unavailable');
          }
          return harness.projects.setState(id, state, code);
        },
      },
      threads: {
        ...harness.threads,
        setState: async (id, state, promptId, code) => {
          if (state === 'cancelling' && rejectThread) {
            rejectThread = false;
            throw new Error('database unavailable');
          }
          return harness.threads.setState(id, state, promptId, code);
        },
      },
      pool: pool(() => {
        releases += 1;
      }),
      execute: async ({ signal }) => {
        started.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return 'cancelled';
      },
    });
    const project = await service.projects.create('Project');
    const created = await service.threads.create(project.id, 'Thread');
    assert.ok(created.status === 'created');
    await service.threads.prompt(created.thread.id, 'work');
    await started.promise;
    await service.threads.prompt(created.thread.id, 'queued');
    await service.projects.terminate(project.id);
    await service.dispose();
    assert.equal(releases, 1);
    assert.equal((await service.projects.find(project.id))?.state, 'cancelled');
    assert.equal(
      (await service.threads.find(created.thread.id))?.state,
      'cancelled',
    );
  },
);

test(
  'fails closed when Direct cannot persist a streamed event after queued acceptance',
  { timeout: 5000 },
  async () => {
    const harness = workspace();
    const started = deferred();
    const finishExecution = deferred();
    const laterExecution = deferred();
    const generation = (harness.dependencies.config as ConfigService).current();
    let failEvent = false;
    let executions = 0;
    const service = createWorkspaceService({
      ...harness.dependencies,
      pool: pool(),
      threads: {
        ...harness.threads,
        appendEvent: async (id, promptId, event) => {
          if (failEvent) {
            failEvent = false;
            throw new Error('event storage unavailable');
          }
          return harness.threads.appendEvent(id, promptId, event);
        },
      },
      config: {
        current: () => ({
          ...generation,
          providers: new Map([
            [
              generation.snapshot.configuration.models.execution.providerId,
              {
                metadata: { id: 'local', name: 'local' },
                stream: async function* () {
                  executions += 1;
                  if (executions > 1) laterExecution.resolve();
                  started.resolve();
                  await finishExecution.promise;
                  yield finish('Result whose streamed event must be durable.');
                },
              },
            ],
          ]),
        }),
      } as never,
    });
    const project = await service.projects.create('Project');
    const created = await service.threads.create(project.id, 'Thread');
    assert.ok(created.status === 'created');
    await service.threads.prompt(created.thread.id, 'first');
    await started.promise;
    assert.equal(
      (await service.threads.prompt(created.thread.id, 'queued')).status,
      'accepted',
    );
    failEvent = true;
    finishExecution.resolve();
    await Promise.race([
      harness.threadState(created.thread.id, 'failed'),
      laterExecution.promise,
    ]);
    assert.equal(
      (await service.threads.find(created.thread.id))?.state,
      'failed',
    );
    assert.equal(
      (await service.threads.prompt(created.thread.id, 'retry')).status,
      'inactive',
    );
    await service.dispose();
    assert.equal(executions, 1);
  },
);
