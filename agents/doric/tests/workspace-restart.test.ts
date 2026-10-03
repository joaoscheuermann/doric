import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { ProviderRequest } from 'llms';

import { runDirectPrompt } from '../src/lib/agents/direct/executor.js';
import { defaultConfig } from '../src/lib/config/schema.js';
import { createProjectStore } from '../src/lib/workspace/projects.js';
import type { ThreadExecution } from '../src/lib/workspace/service.js';
import { createWorkspaceService } from '../src/lib/workspace/service.js';
import { createThreadStore } from '../src/lib/workspace/threads.js';
import type { ThreadEvent } from '../src/lib/workspace/types.js';
import { persistenceFixture } from './helpers/persistence-fixture.js';
import {
  credentialResolver,
  deferred,
  fakeSandbox,
  workspace,
} from './helpers/workspace.js';

const connectionString = process.env.DORIC_TEST_DATABASE_URL;

void test(
  'delivers an exhausted delegated prompt to its parent exactly once',
  { skip: connectionString === undefined, timeout: 10_000 },
  async () => {
    const host = await restart();
    try {
      const { project } = await host.projects.create(
        'Project',
        snapshot,
        'blue',
      );
      const { thread: parent } = await host.threads.create(
        project.id,
        'Parent',
      );
      const { thread: child } = await host.threads.create(
        project.id,
        'Child',
        parent.id,
      );
      const promptId = randomUUID();
      const requestPromptId = randomUUID();
      await host.threads.appendEvent(child.id, promptId, {
        type: 'prompt.accepted',
        text: 'delegated work',
        source: {
          kind: 'parent',
          threadId: parent.id,
          promptId: requestPromptId,
        },
      });
      for (const attempt of [1, 2])
        await host.threads.appendEvent(child.id, promptId, {
          type: 'prompt.resumed',
          attempt,
        });
      await host.threads.reconcile();
      await host.projects.reconcile();
      assert.equal(await host.service.resumeInterrupted(), 1);
      await until(
        async () =>
          (await host.threads.record(parent.id))?.result !== undefined,
      );
      assert.equal(await host.service.resumeInterrupted(), 0);
      const accepted = (await host.threads.eventsAfter(parent.id, 0)).filter(
        ({ type }) => type === 'prompt.accepted',
      );
      assert.equal(accepted.length, 1);
      assert.deepEqual((accepted[0]?.event as { source: unknown }).source, {
        kind: 'result',
        threadId: child.id,
        promptId,
        requestPromptId,
      });
      assert.equal(
        (await host.threads.record(child.id))?.result?.status,
        'failed',
      );
    } finally {
      await host.close();
    }
  },
);

/** The configuration snapshot a Project captures when it is created. */
const snapshot = {
  configuration: defaultConfig,
  revision: 1,
  updatedAt: new Date(0).toISOString(),
};

/**
 * A host booting over the durable records a previous one left: the real stores
 * and the real service, with the sandbox pool and the execution itself standing
 * in as the case needs them. Creating it acquires nothing: only a prompt that
 * needs a Project brings one back.
 */
const restart = async (
  options: {
    readonly execute?: ThreadExecution;
    /** A provider the real Direct executor reads, for a resumed run of its own. */
    readonly providers?: ReadonlyMap<string, unknown>;
  } = {},
) => {
  assert.ok(connectionString);
  const resources = await persistenceFixture(connectionString);
  // The Project's own configuration and the notification surface a real host
  // carries; only the sandbox pool and the execution are this host's own.
  const harness = workspace();
  const acquisitions: { readonly identity?: string }[] = [];
  /** The prompts that reached execution, in the order they did. */
  const ran: string[] = [];
  const projects = createProjectStore(resources.database);
  const threads = createThreadStore(resources.database);
  const execute = options.execute ?? (async () => 'done');
  const service = createWorkspaceService({
    projects,
    threads,
    config:
      options.providers === undefined
        ? harness.dependencies.config
        : ({
            current: () => ({
              snapshot,
              providers: options.providers,
              catalog: { skills: [], tools: [] },
              redactions: () => [],
            }),
          } as never),
    credentials: credentialResolver(),
    pool: {
      acquire: async (value: { readonly identity?: string }) => {
        acquisitions.push(value);
        return { sandbox: fakeSandbox(), release: async () => undefined };
      },
    } as never,
    publisher: harness.dependencies.publisher,
    logger: harness.dependencies.logger,
    discardWorkspace: async () => undefined,
    execute: async (value) => {
      ran.push(value.job.id);
      return execute(value);
    },
  });
  return {
    projects,
    threads,
    service,
    acquisitions,
    ran,
    close: async () => {
      await service.dispose();
      await resources.close();
    },
  };
};

/** Every event of one prompt, in order. */
const eventsOf = async (
  threads: ReturnType<typeof createThreadStore>,
  threadId: string,
  promptId: string,
): Promise<readonly ThreadEvent[]> =>
  (await threads.eventsAfter(threadId, 0)).filter(
    (event) => event.promptId === promptId,
  );

/** The event a run that completes leaves, as this host writes it. */
const completed = {
  type: 'prompt.finished',
  status: 'completed',
  text: 'done',
  source: { kind: 'user' },
};

/** Waits for the runs a resume starts, which the host runs in the background. */
const until = async (
  condition: () => boolean | Promise<boolean>,
): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('The resumed runs never arrived.');
};

test(
  'the boot takes up every prompt the host interrupted and leaves the rest',
  { skip: connectionString === undefined, timeout: 10_000 },
  async () => {
    const host = await restart();
    try {
      // What a crashed host left behind: a Project that needs a sandbox again,
      // and Threads whose prompts were accepted against it.
      const { project } = await host.projects.create(
        'Project',
        snapshot,
        'blue',
      );
      const owner = await host.threads.create(project.id, 'Thread');
      const other = await host.threads.create(project.id, 'Other');
      const { project: idle } = await host.projects.create(
        'Idle project',
        snapshot,
        'green',
      );
      const idleThread = await host.threads.create(idle.id, 'Thread');

      // A run the restart interrupted: accepted, started, never paused.
      const interrupted = randomUUID();
      await host.threads.appendEvent(owner.thread.id, interrupted, {
        type: 'prompt.accepted',
        text: 'finish the work',
        source: { kind: 'user' },
      });
      await host.threads.appendEvent(owner.thread.id, interrupted, {
        type: 'agent.started',
        model: 'test-model',
        input: 'finish the work',
      });
      // A prompt the crash caught between its acceptance and its first run.
      const queued = randomUUID();
      await host.threads.appendEvent(owner.thread.id, queued, {
        type: 'prompt.accepted',
        text: 'and then this',
        source: { kind: 'user' },
      });
      // A prompt the reader stopped: only the reader takes that one up again.
      const stopped = randomUUID();
      await host.threads.appendEvent(other.thread.id, stopped, {
        type: 'prompt.accepted',
        text: 'the reader stopped this',
        source: { kind: 'user' },
      });
      await host.threads.appendEvent(other.thread.id, stopped, {
        type: 'agent.started',
        model: 'test-model',
        input: 'the reader stopped this',
      });
      await host.threads.appendEvent(other.thread.id, stopped, {
        type: 'prompt.paused',
        reason: 'reader_stopped',
      });
      // A prompt that finished: nothing is owed for it.
      const finished = randomUUID();
      await host.threads.appendEvent(other.thread.id, finished, {
        type: 'prompt.accepted',
        text: 'already done',
        source: { kind: 'user' },
      });
      await host.threads.appendEvent(other.thread.id, finished, {
        type: 'prompt.finished',
        status: 'completed',
        text: 'done',
        source: { kind: 'user' },
      });
      const closed = await eventsOf(host.threads, other.thread.id, finished);
      // The idle Project holds only a finished prompt, so it owes nothing.
      const done = randomUUID();
      await host.threads.appendEvent(idleThread.thread.id, done, {
        type: 'prompt.accepted',
        text: 'nothing owed',
        source: { kind: 'user' },
      });
      await host.threads.appendEvent(idleThread.thread.id, done, {
        type: 'prompt.finished',
        status: 'completed',
        text: 'done',
        source: { kind: 'user' },
      });
      for (const thread of [
        owner.thread.id,
        other.thread.id,
        idleThread.thread.id,
      ]) {
        await host.threads.setState(thread, 'running', undefined, 'original');
      }

      // The boot: reconcile, then take up what the host owes.
      await host.threads.reconcile();
      await host.projects.reconcile();
      const resumed = await host.service.resumeInterrupted();
      await until(
        async () =>
          (await host.threads.record(owner.thread.id))?.result?.promptId ===
          queued,
      );

      assert.equal(resumed, 2, 'the two owed prompts are re-enqueued');
      // Both ran, in the order the log accepted them, each under its own prompt and
      // each opening its own next attempt.
      assert.deepEqual(host.ran, [interrupted, queued]);
      assert.deepEqual(
        (await eventsOf(host.threads, owner.thread.id, interrupted)).map(
          ({ event }) => event,
        ),
        [
          {
            type: 'prompt.accepted',
            text: 'finish the work',
            source: { kind: 'user' },
          },
          {
            type: 'agent.started',
            model: 'test-model',
            input: 'finish the work',
          },
          { type: 'prompt.paused', reason: 'host_restarted' },
          { type: 'prompt.resumed', attempt: 1 },
          completed,
        ],
      );
      assert.deepEqual(
        (await eventsOf(host.threads, owner.thread.id, queued)).map(
          ({ event }) => event,
        ),
        [
          {
            type: 'prompt.accepted',
            text: 'and then this',
            source: { kind: 'user' },
          },
          { type: 'prompt.resumed', attempt: 1 },
          completed,
        ],
      );
      // The reader's own stop is left for the reader, and the finished prompt is
      // untouched.
      assert.deepEqual(
        (await eventsOf(host.threads, other.thread.id, stopped)).map(
          ({ type }) => type,
        ),
        ['prompt.accepted', 'agent.started', 'prompt.paused'],
      );
      assert.deepEqual(
        await eventsOf(host.threads, other.thread.id, finished),
        closed,
      );
      // Only the Project that owed work came back, and it came back as itself.
      assert.deepEqual(
        host.acquisitions.map(({ identity }) => identity),
        [project.id],
      );
      assert.equal((await host.projects.record(idle.id))?.state, 'queued');
    } finally {
      await host.close();
    }
  },
);

test(
  'continues a resumed prompt from the history it had already written',
  { skip: connectionString === undefined, timeout: 10_000 },
  async () => {
    const requests: ProviderRequest[] = [];
    const host = await restart({
      execute: runDirectPrompt,
      providers: new Map([
        [
          defaultConfig.models.execution.providerId,
          {
            metadata: { id: 'local', name: 'local' },
            stream: async function* (request: ProviderRequest) {
              requests.push(request);
              yield {
                type: 'response.finished' as const,
                finish: {
                  text: 'continued',
                  finishReason: 'stop' as const,
                  toolCalls: [],
                },
              };
            },
          },
        ],
      ]),
    });
    try {
      const { project } = await host.projects.create(
        'Project',
        snapshot,
        'blue',
      );
      const { thread } = await host.threads.create(project.id, 'Thread');
      const callId = 'call-1';
      const promptId = randomUUID();
      await host.threads.appendEvent(thread.id, promptId, {
        type: 'prompt.accepted',
        text: 'finish the work',
        source: { kind: 'user' },
      });
      await host.threads.appendEvent(thread.id, promptId, {
        type: 'agent.started',
        model: 'local',
        input: 'finish the work',
      });
      // The turn boundary the host records before a run reads its history, and
      // exactly what a run stopped in the middle of a tool then leaves behind:
      // its input, the assistant turn that asked for the tool, and that tool's
      // own result, all persisted as the run advanced.
      await host.threads.saveCheckpoint(thread.id, promptId);
      await host.threads.saveMessages(thread.id, [
        { role: 'user', content: '# User request\n\nfinish the work' },
        {
          role: 'assistant',
          content: 'Inspecting.',
          toolCalls: [{ id: callId, name: 'inspect', arguments: '{}' }],
        },
        { role: 'tool', toolCallId: callId, content: 'observed' },
      ]);
      await host.threads.setState(thread.id, 'running', undefined, 'original');

      await host.threads.reconcile();
      await host.projects.reconcile();
      const resumed = await host.service.resumeInterrupted();
      assert.equal(resumed, 1);
      await until(
        async () =>
          (await host.threads.record(thread.id))?.result?.promptId === promptId,
      );

      // The run continued from where the last one stopped: the tool result it
      // already had is still there, its own input is carried once, and the run
      // completed on the text the accepted input recorded.
      const sent = requests.at(-1)?.messages ?? [];
      assert.deepEqual(sent.slice(1), [
        { role: 'user', content: '# User request\n\nfinish the work' },
        {
          role: 'assistant',
          content: 'Inspecting.',
          toolCalls: [{ id: callId, name: 'inspect', arguments: '{}' }],
        },
        { role: 'tool', toolCallId: callId, content: 'observed' },
      ]);
      assert.deepEqual(
        (await eventsOf(host.threads, thread.id, promptId)).at(-1)?.event,
        { ...completed, text: 'continued' },
      );
    } finally {
      await host.close();
    }
  },
);

test(
  'closes a prompt the host interrupted three times and still honours the reader',
  { skip: connectionString === undefined, timeout: 10_000 },
  async () => {
    const host = await restart();
    try {
      const { project } = await host.projects.create(
        'Project',
        snapshot,
        'blue',
      );
      const { thread } = await host.threads.create(project.id, 'Thread');

      // A prompt the host has already taken up twice, interrupted once more: the
      // attempt a boot would make is the third interruption, over its budget.
      const exhausted = randomUUID();
      await host.threads.appendEvent(thread.id, exhausted, {
        type: 'prompt.accepted',
        text: 'keeps dying',
        source: { kind: 'user' },
      });
      await host.threads.appendEvent(thread.id, exhausted, {
        type: 'agent.started',
        model: 'test-model',
        input: 'keeps dying',
      });
      for (const attempt of [1, 2]) {
        await host.threads.appendEvent(thread.id, exhausted, {
          type: 'prompt.paused',
          reason: 'host_stopped',
        });
        await host.threads.appendEvent(thread.id, exhausted, {
          type: 'prompt.resumed',
          attempt,
        });
      }
      // A prompt the reader stopped, after the host had taken it up twice: the
      // budget is the host's own rule, so this one is still the reader's.
      const reader = randomUUID();
      await host.threads.appendEvent(thread.id, reader, {
        type: 'prompt.accepted',
        text: 'the reader paused this',
        source: { kind: 'user' },
      });
      for (const attempt of [1, 2]) {
        await host.threads.appendEvent(thread.id, reader, {
          type: 'prompt.resumed',
          attempt,
        });
      }
      await host.threads.appendEvent(thread.id, reader, {
        type: 'prompt.paused',
        reason: 'reader_stopped',
      });
      await host.threads.setState(thread.id, 'running');

      await host.threads.reconcile();
      await host.projects.reconcile();
      assert.equal(
        await host.service.resumeInterrupted(),
        0,
        'the host resumes nothing it has stopped taking up',
      );

      // The prompt is closed as a failure, in the shape a failed run leaves, with
      // the reason the reader has to read.
      assert.deepEqual(
        (await eventsOf(host.threads, thread.id, exhausted))
          .slice(-3)
          .map(({ event }) => event),
        [
          { type: 'prompt.paused', reason: 'host_restarted' },
          {
            type: 'agent.failed',
            error: {
              name: 'ResumeExhaustedError',
              code: 'resume_exhausted',
              message:
                'A execução foi interrompida três vezes por reinício do host e não foi ' +
                'retomada de novo. O trabalho pode estar incompleto; mande o prompt ' +
                'novamente para continuar.',
            },
          },
          {
            type: 'prompt.finished',
            status: 'failed',
            text: 'The prompt failed.',
            source: { kind: 'user' },
          },
        ],
      );
      const record = await host.threads.record(thread.id);
      assert.equal(record?.result?.status, 'failed');
      assert.equal(record?.result?.promptId, exhausted);
      assert.deepEqual(host.ran, [], 'nothing was resumed');

      // The reader's own resume is not capped: the prompt is still unfinished and
      // the reader is the one asking.
      const resumed = await host.service.threads.resume(thread.id, reader);
      assert.ok(resumed.status === 'resumed');
      assert.equal(resumed.thread.id, thread.id);
      await until(
        async () =>
          (await host.threads.record(thread.id))?.result?.promptId === reader,
      );
      assert.deepEqual(
        (await eventsOf(host.threads, thread.id, reader)).map(
          ({ event }) => event,
        ),
        [
          {
            type: 'prompt.accepted',
            text: 'the reader paused this',
            source: { kind: 'user' },
          },
          { type: 'prompt.resumed', attempt: 1 },
          { type: 'prompt.resumed', attempt: 2 },
          { type: 'prompt.paused', reason: 'reader_stopped' },
          { type: 'prompt.resumed', attempt: 3 },
          completed,
        ],
      );
    } finally {
      await host.close();
    }
  },
);

test(
  'resumes one reader-paused prompt on demand, bringing its Project back',
  { skip: connectionString === undefined, timeout: 10_000 },
  async () => {
    // The run is held open, so the prompt is still the Thread's own work when the
    // reader asks for it a second time.
    const running = deferred();
    const host = await restart({
      execute: async () => {
        await running.promise;
        return 'done';
      },
    });
    try {
      const { project } = await host.projects.create(
        'Project',
        snapshot,
        'blue',
      );
      const { thread } = await host.threads.create(project.id, 'Thread');
      const promptId = randomUUID();
      await host.threads.appendEvent(thread.id, promptId, {
        type: 'prompt.accepted',
        text: 'paused by its reader',
        source: { kind: 'user' },
      });
      await host.threads.appendEvent(thread.id, promptId, {
        type: 'agent.started',
        model: 'test-model',
        input: 'paused by its reader',
      });
      await host.threads.appendEvent(thread.id, promptId, {
        type: 'prompt.paused',
        reason: 'reader_stopped',
      });
      await host.threads.setState(thread.id, 'ready');
      await host.projects.reconcile();
      await host.threads.reconcile();

      const resumed = await host.service.threads.resume(thread.id, promptId);
      assert.ok(resumed.status === 'resumed');
      assert.equal(resumed.thread.id, thread.id);
      await until(() => host.ran.length === 1);
      // The prompt is the Thread's own running work now, so asking for it again
      // cannot queue the same turn twice.
      assert.deepEqual(await host.service.threads.resume(thread.id, promptId), {
        status: 'busy',
      });
      running.resolve();
      await until(
        async () =>
          (await host.threads.record(thread.id))?.result?.promptId === promptId,
      );

      assert.deepEqual(
        (await eventsOf(host.threads, thread.id, promptId)).map(
          ({ event }) => event,
        ),
        [
          {
            type: 'prompt.accepted',
            text: 'paused by its reader',
            source: { kind: 'user' },
          },
          {
            type: 'agent.started',
            model: 'test-model',
            input: 'paused by its reader',
          },
          { type: 'prompt.paused', reason: 'reader_stopped' },
          { type: 'prompt.resumed', attempt: 1 },
          completed,
        ],
      );
      // The Project came back for its own prompt, with its own identity.
      assert.deepEqual(
        host.acquisitions.map(({ identity }) => identity),
        [project.id],
      );
      // Only a prompt this Thread holds unfinished is a resume target, and a
      // Thread the host does not hold is not one either.
      assert.deepEqual(
        await host.service.threads.resume(thread.id, randomUUID()),
        { status: 'unknown_prompt' },
      );
      assert.deepEqual(
        await host.service.threads.resume(randomUUID(), promptId),
        { status: 'missing' },
      );
    } finally {
      await host.close();
    }
  },
);
