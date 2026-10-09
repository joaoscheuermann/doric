import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import express from 'express';
import type { ProviderMessage, ProviderRequest } from 'llms';
import pino from 'pino';

import { createDirectExecutor } from '../src/lib/agents/direct/executor.js';
import { createHostAdapter } from '../src/lib/bundles/adapter.js';
import {
  type Bundles,
  recoverGenerationLoss,
  startBundles,
} from '../src/lib/bundles/boot.js';
import type { ConfigService } from '../src/lib/config/service.js';
import { createWorkspaceService } from '../src/lib/workspace/service.js';
import type { ThreadEvent } from '../src/lib/workspace/types.js';
import { createToolsRouter } from '../src/routes/tools.js';
import { bundlesPath, compositionPath } from './helpers/bundles.js';
import { pool, workspace } from './helpers/workspace.js';

// Build doric first: these tests copy the bundles the host stages in
// dist/bundles, add the plain-JS fixtures and boot them through the kernel,
// which forks the compiled generation runner. The roots live below
// dist-tests so the fixtures resolve `bundle`, `tool` and `zod` exactly as the
// staged bundles do.

const fixtures = 'agents/doric/tests/fixtures/generation-bundles';

/** What the host answers a tool call a lost process interrupted with. */
const interrupted =
  'The host was restarted while this tool call was running, so its result was lost. ' +
  'Call it again if you still need it.';

interface Root {
  readonly path: string;
  readonly bundles: string;
  readonly composition: string;
}

/** A bundles root with the staged bundles and the given fixtures enabled. */
const createRoot = async (extra: readonly string[]): Promise<Root> => {
  const path = await mkdtemp(join('agents/doric/dist-tests', 'generations-'));
  const bundles = join(path, 'bundles');

  await cp(bundlesPath, bundles, { recursive: true });

  for (const id of extra)
    await cp(join(fixtures, id), join(bundles, id), { recursive: true });

  const composition = JSON.parse(await readFile(compositionPath, 'utf8')) as {
    readonly enabled: readonly string[];
  };

  await writeFile(
    join(path, 'composition.json'),
    JSON.stringify({
      ...composition,
      enabled: [...composition.enabled, ...extra],
    }),
  );

  return { path, bundles, composition: join(path, 'composition.json') };
};

/**
 * The model of these scenarios. A prompt `gate <name>` calls `probe` with a
 * release gate and reports what the tool answered; `again <name>` reports the
 * answer of a second, ungated call after an interrupted one; `loop <name>`
 * keeps calling a fresh gate; anything else is answered directly.
 */
const createProvider = (root: string) => {
  const requests: ProviderRequest[] = [];
  /** Every gate a probe call was given, so a closing host can release them. */
  const gates = new Set<string>();
  const gate = (name: string) => {
    const path = resolve(root, name);
    gates.add(path);
    return path;
  };
  const toolMessages = (messages: readonly ProviderMessage[]) =>
    messages.filter(({ role }) => role === 'tool');
  const call = (args: unknown) => ({
    type: 'response.finished' as const,
    finish: {
      text: '',
      finishReason: 'tool_calls' as const,
      toolCalls: [
        {
          id: `call-${String(requests.length)}`,
          name: 'probe',
          arguments: JSON.stringify(args),
        },
      ],
    },
  });
  const answer = (text: string) => ({
    type: 'response.finished' as const,
    finish: { text, finishReason: 'stop' as const, toolCalls: [] },
  });

  return {
    requests,
    gates,
    stream: async function* (request: ProviderRequest) {
      requests.push(request);
      const input = request.messages
        .filter(({ role }) => role === 'user')
        .at(-1)?.content;
      assert.ok(typeof input === 'string');
      const text = input.replace(/^# User request\n\n/u, '');
      const [command, name] = text.split(' ') as [string, string | undefined];
      const results = toolMessages(request.messages);
      const last = request.messages.at(-1);

      if (command === 'loop') {
        yield call({ gate: gate(`${String(name)}-${String(results.length)}`) });
      } else if (command === 'gate' && last?.role !== 'tool') {
        yield call({ gate: gate(String(name)) });
      } else if (
        command === 'again' &&
        (last?.role !== 'tool' || last.content === interrupted)
      ) {
        yield call(results.length === 0 ? { gate: gate(String(name)) } : {});
      } else {
        yield answer(
          last?.role === 'tool' ? String(last.content) : `answer ${text}`,
        );
      }
    },
  };
};

interface Host {
  readonly bundles: Bundles;
  readonly root: Root;
  readonly service: ReturnType<typeof createWorkspaceService>;
  readonly events: ThreadEvent[];
  readonly requests: ProviderRequest[];
  /** Releases the probe call waiting on this gate. */
  readonly release: (gate: string) => Promise<void>;
  /** Resolves once a probe call waits on this gate, with its process id. */
  readonly started: (gate: string) => Promise<number>;
  readonly thread: () => Promise<{ readonly id: string }>;
  readonly prompt: (threadId: string, text: string) => Promise<string>;
  readonly close: () => Promise<void>;
}

let current: Host | undefined;

/** Polls a condition the host reaches asynchronously. */
const until = async (
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline)
      throw new Error(
        `Timed out waiting: ${what}; events: ${JSON.stringify(
          current?.events.map(({ type, event }) => [type, event]),
        )}`,
      );
    await delay(20);
  }
};

/** Boots the host's bundles and a workspace over them, as the host does. */
const bootHost = async (extra: readonly string[] = ['probe']) => {
  const root = await createRoot(extra);
  const adapter = createHostAdapter();
  const bundles = await startBundles({
    bundlesPath: root.bundles,
    compositionPath: root.composition,
    adapter,
    logger: pino({ enabled: false }),
  });
  const harness = workspace();
  const provider = createProvider(root.path);
  const base = (harness.dependencies.config as ConfigService).current();
  const config = {
    current: () => ({
      ...base,
      providers: new Map([
        [
          base.snapshot.configuration.models.execution.providerId,
          provider as never,
        ],
      ]),
    }),
    catalog: bundles.catalog,
    replace: () => {
      throw new Error('Configuration is not replaced in this test');
    },
  } satisfies ConfigService;
  const service = createWorkspaceService({
    ...harness.dependencies,
    config,
    pool: pool(),
    execute: createDirectExecutor({
      acquire: bundles.acquire,
      attach: adapter.attach,
    }),
  });
  const unwatch = recoverGenerationLoss(bundles.platform.generations, service);
  const project = await service.projects.create('Project');
  const gatePath = (gate: string) => resolve(root.path, gate);

  return {
    bundles,
    root,
    service,
    events: harness.events,
    requests: provider.requests,
    release: (gate) => writeFile(`${gatePath(gate)}.release`, ''),
    started: async (gate) => {
      let pid: string | undefined;
      await until(async () => {
        pid = await readFile(`${gatePath(gate)}.started`, 'utf8').catch(
          () => undefined,
        );
        return pid !== undefined;
      }, `probe gate ${gate}`);
      return Number(pid);
    },
    thread: async () => {
      const created = await service.threads.create(project.id, 'Thread');
      assert.ok(created.status === 'created');
      return created.thread;
    },
    prompt: async (threadId, text) => {
      const result = await service.threads.prompt(threadId, text);
      assert.ok(result.status === 'accepted');
      return result.promptId;
    },
    close: async () => {
      // A probe call still waiting would hold the host's stop.
      for (const path of provider.gates) await writeFile(`${path}.release`, '');
      unwatch();
      await service.dispose();
      await bundles.platform.stop();
      await rm(root.path, { recursive: true, force: true });
    },
  } satisfies Host;
};

/** The events of one prompt, in order, as type and payload. */
const promptEvents = (host: Host, promptId: string) =>
  host.events
    .filter((event) => event.promptId === promptId)
    .map(({ type, event }) => ({ type, event }));

const finished = (host: Host, promptId: string) =>
  promptEvents(host, promptId).find(({ type }) => type === 'prompt.finished')
    ?.event as { readonly status: string; readonly text: string } | undefined;

const waitFinished = async (host: Host, promptId: string) => {
  await until(
    () => finished(host, promptId) !== undefined,
    `prompt ${promptId}`,
  );
  return finished(host, promptId) as { status: string; text: string };
};

/** What the probe tool answered: the generation and process it ran in. */
const probed = (text: string) =>
  JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as {
    readonly generation: number;
    readonly pid: number;
  };

const active = (host: Host) =>
  host.bundles.platform.generations
    .describe()
    .find(({ state }) => state === 'active');

const exited = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

/** GET /tools of the host, over HTTP. */
const getTools = async (host: Host): Promise<string> => {
  const app = express();
  app.use(
    '/tools',
    createToolsRouter({ catalog: host.bundles.catalog } as never),
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');
    return await (
      await fetch(`http://127.0.0.1:${String(address.port)}/tools`)
    ).text();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

const withHost = async (
  run: (host: Host) => Promise<void>,
  extra?: readonly string[],
) => {
  const host = await bootHost(extra);
  current = host;
  try {
    await run(host);
  } finally {
    await host.close();
  }
};

void test('a published generation replaces the active one while the host keeps serving', {
  timeout: 60_000,
}, async () => {
  await withHost(async (host) => {
    const before = await getTools(host);
    const first = active(host);
    assert.ok(first?.pid !== undefined);
    assert.ok(
      JSON.parse(before).tools.some(
        ({ name }: { name: string }) => name === 'probe',
      ),
    );

    assert.deepEqual(await host.bundles.platform.generations.publish(), {
      status: 'published',
      generation: 2,
    });

    assert.equal(await getTools(host), before);
    const thread = await host.thread();
    const probe = await host.prompt(thread.id, 'gate after-publish');
    await host.release('after-publish');
    const result = await waitFinished(host, probe);
    assert.equal(result.status, 'completed');
    assert.equal(probed(result.text).generation, 2);
    assert.notEqual(probed(result.text).pid, process.pid);
    await until(() => exited(first.pid as number), 'generation 1 exit');
    assert.deepEqual(
      host.bundles.platform.generations
        .describe()
        .map(({ generation, state }) => ({ generation, state })),
      [
        { generation: 1, state: 'stopped' },
        { generation: 2, state: 'active' },
      ],
    );
  });
});

void test('a change to the kernel partition requires a restart', {
  timeout: 60_000,
}, async () => {
  await withHost(async (host) => {
    const manifestPath = join(host.root.bundles, 'postgres', 'manifest.json');
    const descriptorPath = join(
      host.root.bundles,
      'postgres',
      'contracts.json',
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
    await writeFile(
      manifestPath,
      JSON.stringify({ ...manifest, version: '1.0.1' }),
    );
    await writeFile(
      descriptorPath,
      JSON.stringify({
        ...descriptor,
        bundle: { ...descriptor.bundle, version: '1.0.1' },
      }),
    );

    const outcome = await host.bundles.platform.generations.publish();

    assert.equal(outcome.status, 'kernel_restart_required');
    assert.deepEqual(
      host.bundles.platform.generations
        .describe()
        .map(({ generation, state }) => ({ generation, state })),
      [{ generation: 1, state: 'active' }],
    );
  });
});

void test('a running prompt finishes on the generation it started on', {
  timeout: 60_000,
}, async () => {
  await withHost(async (host) => {
    const first = await host.thread();
    const second = await host.thread();
    const a = await host.prompt(first.id, 'gate a');
    const oldPid = await host.started('a');
    const queued = await host.prompt(first.id, 'gate queued');

    assert.equal(
      (await host.bundles.platform.generations.publish()).status,
      'published',
    );

    const b = await host.prompt(second.id, 'gate b');
    await host.started('b');
    await host.release('b');
    assert.equal(probed((await waitFinished(host, b)).text).generation, 2);
    // Generation 1 still serves the prompt pinned to it.
    assert.equal(exited(oldPid), false);
    assert.equal(
      host.bundles.platform.generations
        .describe()
        .find(({ generation }) => generation === 1)?.state,
      'draining',
    );

    await host.release('a');
    const result = await waitFinished(host, a);
    assert.equal(result.status, 'completed');
    assert.deepEqual(probed(result.text), { generation: 1, pid: oldPid });
    await host.release('queued');
    assert.equal(probed((await waitFinished(host, queued)).text).generation, 2);
    await until(() => exited(oldPid), 'generation 1 exit');
  });
});

void test('a generation crash pauses its prompts and resumes them from the checkpoint', {
  timeout: 60_000,
}, async () => {
  await withHost(async (host) => {
    const running = await host.thread();
    const idle = await host.thread();
    const idleSequence = host.events.filter(
      ({ threadId }) => threadId === idle.id,
    ).length;
    const a = await host.prompt(running.id, 'gate crash');
    const pid = await host.started('crash');

    process.kill(pid, 'SIGKILL');

    const result = await waitFinished(host, a);
    assert.equal(result.status, 'completed');
    assert.equal(result.text, interrupted);
    const types = promptEvents(host, a).map(({ type, event }) =>
      type === 'prompt.paused' || type === 'prompt.resumed'
        ? { type, event }
        : type,
    );
    assert.equal(types.includes('tool.failed'), false);
    assert.equal(types.includes('agent.failed'), false);
    // The pause and the next attempt, in order, with nothing failed between.
    assert.deepEqual(
      types.filter((value) => typeof value === 'object'),
      [
        {
          type: 'prompt.paused',
          event: { type: 'prompt.paused', reason: 'host_restarted' },
        },
        {
          type: 'prompt.resumed',
          event: { type: 'prompt.resumed', attempt: 1 },
        },
      ],
    );
    // The resumed run answered the interrupted call instead of running it.
    const resumed = host.requests.at(-1);
    assert.deepEqual(resumed?.messages.at(-1), {
      role: 'tool',
      toolCallId: 'call-1',
      content: interrupted,
      toolResultStatus: 'incomplete',
    });
    assert.deepEqual(
      host.bundles.platform.generations
        .describe()
        .map(({ generation, incarnation, state }) => ({
          generation,
          incarnation,
          state,
        })),
      [{ generation: 1, incarnation: 2, state: 'active' }],
    );
    assert.equal(
      host.events.filter(({ threadId }) => threadId === idle.id).length,
      idleSequence,
    );
    // The respawned generation serves the Thread's next prompt.
    const next = await host.prompt(running.id, 'gate next');
    await host.release('next');
    assert.equal(probed((await waitFinished(host, next)).text).generation, 1);
    assert.notEqual(probed(finished(host, next)?.text ?? '').pid, pid);
  });
});

void test('three generation crashes exhaust a prompt like three host crashes', {
  timeout: 90_000,
}, async () => {
  await withHost(async (host) => {
    const thread = await host.thread();
    const a = await host.prompt(thread.id, 'loop exhaust');

    for (const attempt of [0, 1, 2]) {
      const pid = await host.started(`exhaust-${String(attempt)}`);
      process.kill(pid, 'SIGKILL');
    }

    const result = await waitFinished(host, a);
    assert.deepEqual(result, {
      type: 'prompt.finished',
      status: 'failed',
      text: 'The prompt failed.',
      source: { kind: 'user' },
    });
    const events = promptEvents(host, a);
    assert.deepEqual(
      events
        .filter(({ type }) => type === 'prompt.resumed')
        .map(({ event }) => event),
      [
        { type: 'prompt.resumed', attempt: 1 },
        { type: 'prompt.resumed', attempt: 2 },
      ],
    );
    assert.equal(
      events.filter(
        ({ type, event }) =>
          type === 'prompt.paused' &&
          (event as { reason: string }).reason === 'host_restarted',
      ).length,
      3,
    );
    assert.deepEqual(
      events.find(({ type }) => type === 'agent.failed')?.event,
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
    );
    const later = await host.prompt(thread.id, 'plain');
    assert.equal((await waitFinished(host, later)).status, 'completed');
  });
});

void test("a draining generation's crash resumes its prompts on the active one", {
  timeout: 60_000,
}, async () => {
  await withHost(async (host) => {
    const thread = await host.thread();
    const a = await host.prompt(thread.id, 'again drain');
    const pid = await host.started('drain');

    assert.equal(
      (await host.bundles.platform.generations.publish()).status,
      'published',
    );
    process.kill(pid, 'SIGKILL');

    const result = await waitFinished(host, a);
    assert.equal(result.status, 'completed');
    assert.equal(probed(result.text).generation, 2);
    assert.ok(
      promptEvents(host, a).some(
        ({ type, event }) =>
          type === 'prompt.resumed' &&
          (event as { attempt: number }).attempt === 1,
      ),
    );
    assert.deepEqual(
      host.bundles.platform.generations
        .describe()
        .map(({ generation, incarnation, state }) => ({
          generation,
          incarnation,
          state,
        })),
      [
        { generation: 1, incarnation: 1, state: 'stopped' },
        { generation: 2, incarnation: 1, state: 'active' },
      ],
    );
  });
});

void test('a generation that keeps crashing at start quarantines its bundles and the host keeps serving', {
  timeout: 60_000,
}, async () => {
  await withHost(
    async (host) => {
      const generationBundles = [
        'files',
        'git',
        'threads',
        'probe',
        'crash-on-activate',
      ];
      const diagnostics = host.bundles.platform.diagnostics();
      for (const id of generationBundles) {
        const bundle = diagnostics.bundles.find((entry) => entry.id === id);
        assert.equal(bundle?.state, 'quarantined', id);
        assert.ok(
          bundle?.reasons.some(({ code }) => code === 'generation_failed'),
          id,
        );
      }
      assert.ok(
        host.bundles.platform
          .catalog()
          .bundles.filter(({ id }) => generationBundles.includes(id))
          .every(({ state }) => state === 'quarantined'),
      );
      assert.deepEqual(JSON.parse(await getTools(host)), { tools: [] });
      const thread = await host.thread();
      const promptId = await host.prompt(thread.id, 'plain');
      assert.deepEqual(await waitFinished(host, promptId), {
        type: 'prompt.finished',
        status: 'completed',
        text: 'answer plain',
        source: { kind: 'user' },
      });
    },
    ['probe', 'crash-on-activate'],
  );
});
