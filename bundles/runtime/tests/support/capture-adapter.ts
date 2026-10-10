import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  AnyServiceDefinition,
  Call,
  CallScope,
  HostContext,
  Services,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import { TerminalV1 } from 'terminal/contracts';

import {
  RuntimeLeaseV1,
  RuntimeThreadsV1,
  RuntimeWorkspaceV1,
} from '../../src/contracts/index.js';

/*
 * Golden transcripts of the stage-1 `host-adapter` (design 57 §13, 57-WP-0).
 * One scripted scenario calls every method of `runtime.threads/v1`,
 * `runtime.workspace/v1`, `runtime.lease/v1` and `terminal/v1` through the
 * dispatcher, as a bundle tool does, from a running parent prompt; then again
 * after the prompt ended (`inactive`), and once with a facade that has no
 * terminals (the `unavailable` refusal). The recording runs over the real
 * kernel WorkspaceService and Prisma stores, so 57-WP-R2 can replay the same
 * scenario against the runtime providers and compare.
 *
 * The kernel modules are imported from agents/doric's test build by path:
 * the runtime package cannot depend on the kernel, and this recording is
 * only possible while the adapter exists (57-WP-K deletes it).
 */

export const transcriptPath =
  'bundles/runtime/tests/fixtures/adapter-parity/transcript.json';

/** An outcome as a tool observes it: a value, or a rejection's identity. */
export type Outcome =
  | { readonly value: unknown }
  /** A method that resolved with no value (JSON has no `undefined`). */
  | { readonly void: true }
  | {
      readonly error: {
        readonly name: string;
        readonly message: string;
        readonly code?: string;
      };
    };

export interface TranscriptStep {
  readonly label: string;
  /** `bound` (prompt running), `ended` (after its end) or `no-terminals`. */
  readonly phase: Phase;
  readonly contract: string;
  readonly method: string;
  readonly args: readonly unknown[];
  readonly outcome: Outcome;
}

export interface Transcript {
  readonly version: 1;
  readonly source: 'host-adapter';
  readonly setup: typeof setup;
  readonly steps: readonly TranscriptStep[];
}

type Phase = 'bound' | 'ended' | 'no-terminals';

/** What the scenario's environment holds; a replay builds the same one. */
export const setup = {
  project: 'Project',
  parentThread: 'Parent',
  parentPrompt: 'parent',
  /** Every other prompt finishes at once with this text plus the prompt. */
  childResultPrefix: 'done: ',
  sandbox: {
    id: 'vm-1',
    root: '/workspace',
    entries: [{ path: 'notes.txt', content: 'hello\n' }, { path: 'repo' }],
  },
  /** A UUID no record has. */
  unknownId: '00000000-0000-4000-8000-0000000000aa',
} as const;

/** The environment one scenario runs in: a kernel recording or a replay. */
export interface CaptureDriver {
  /** Services of a consumer bundle whose calls reach the providers. */
  readonly services: Services;
  call(scope: CallScope): Call;
  /** Starts the parent prompt and answers its scope once it is bound. */
  start(): Promise<CallScope>;
  /** Waits until a Thread finished `promptId` and holds no other work. */
  settle(threadId: string, promptId: string): Promise<void>;
  /** Ends the parent prompt and waits until its binding is released. */
  end(): Promise<void>;
  /** Binds the ended prompt's scope again with a facade without terminals. */
  bindWithoutTerminals(scope: CallScope): () => void;
  dispose(): Promise<void>;
}

interface Context {
  readonly scope: CallScope;
  child?: string;
  childPrompt?: string;
  secondPrompt?: string;
}

interface Step {
  readonly label: string;
  readonly phase: Phase;
  readonly contract:
    | typeof RuntimeThreadsV1
    | typeof RuntimeWorkspaceV1
    | typeof RuntimeLeaseV1
    | typeof TerminalV1;
  readonly method: string;
  readonly args: (context: Context) => readonly unknown[];
  /** Reads what later steps need from this step's value. */
  readonly keep?: (context: Context, value: unknown) => void;
  /** The Thread and prompt to settle after the step. */
  readonly settle?: (
    context: Context,
  ) => readonly [threadId: string, promptId: string];
}

const child = (context: Context): string => context.child as string;
const unknown = setup.unknownId;
const terminalInput = {
  command: 'ls',
  cwd: '/workspace',
  timeoutMs: 1000,
};

/** The scenario, in order. Each step runs once. */
export const scenario: readonly Step[] = [
  {
    label: 'cwd starts at the workspace root',
    phase: 'bound',
    contract: RuntimeWorkspaceV1,
    method: 'cwd',
    args: () => [],
  },
  {
    label: 'setCwd into a directory',
    phase: 'bound',
    contract: RuntimeWorkspaceV1,
    method: 'setCwd',
    args: () => ['repo'],
  },
  {
    label: 'setCwd to a missing path',
    phase: 'bound',
    contract: RuntimeWorkspaceV1,
    method: 'setCwd',
    args: () => ['/workspace/absent'],
  },
  {
    label: 'setCwd to a file',
    phase: 'bound',
    contract: RuntimeWorkspaceV1,
    method: 'setCwd',
    args: () => ['/workspace/notes.txt'],
  },
  {
    label: 'setCwd outside the workspace',
    phase: 'bound',
    contract: RuntimeWorkspaceV1,
    method: 'setCwd',
    args: () => ['../../etc'],
  },
  {
    label: 'cwd after the moves',
    phase: 'bound',
    contract: RuntimeWorkspaceV1,
    method: 'cwd',
    args: () => [],
  },
  {
    label: 'describe the lease',
    phase: 'bound',
    contract: RuntimeLeaseV1,
    method: 'describe',
    args: () => [],
  },
  {
    label: 'exec a shell command',
    phase: 'bound',
    contract: RuntimeLeaseV1,
    method: 'exec',
    args: () => [{ cmd: ['sh', '-c', 'true'], cwd: '/workspace' }],
  },
  {
    label: 'write a file',
    phase: 'bound',
    contract: RuntimeLeaseV1,
    method: 'writeFile',
    args: () => ['/workspace/new.txt', 'written\n'],
  },
  {
    label: 'read the written file',
    phase: 'bound',
    contract: RuntimeLeaseV1,
    method: 'readFile',
    args: () => ['/workspace/new.txt'],
  },
  {
    label: 'read a scripted file',
    phase: 'bound',
    contract: RuntimeLeaseV1,
    method: 'readFile',
    args: () => ['/workspace/notes.txt'],
  },
  {
    label: 'read a missing file',
    phase: 'bound',
    contract: RuntimeLeaseV1,
    method: 'readFile',
    args: () => ['/workspace/absent.txt'],
  },
  {
    label: 'list without children',
    phase: 'bound',
    contract: RuntimeThreadsV1,
    method: 'list',
    args: () => [10],
  },
  {
    label: 'spawn a child',
    phase: 'bound',
    contract: RuntimeThreadsV1,
    method: 'spawn',
    args: () => ['child task'],
    keep: (context, value) => {
      const spawned = value as { threadId: string; promptId: string };

      context.child = spawned.threadId;
      context.childPrompt = spawned.promptId;
    },
    settle: (context) => [child(context), context.childPrompt as string],
  },
  {
    label: 'get the finished child',
    phase: 'bound',
    contract: RuntimeThreadsV1,
    method: 'get',
    args: (context) => [child(context)],
  },
  {
    label: 'first page of child events',
    phase: 'bound',
    contract: RuntimeThreadsV1,
    method: 'events',
    args: (context) => [child(context), 0, 2],
  },
  {
    label: 'rest of the child events',
    phase: 'bound',
    contract: RuntimeThreadsV1,
    method: 'events',
    args: (context) => [child(context), 2, 100],
  },
  {
    label: 'send the child another prompt',
    phase: 'bound',
    contract: RuntimeThreadsV1,
    method: 'send',
    args: (context) => [child(context), 'second task'],
    keep: (context, value) => {
      context.secondPrompt = (value as { promptId: string }).promptId;
    },
    settle: (context) => [child(context), context.secondPrompt as string],
  },
  {
    label: 'get the child after the second prompt',
    phase: 'bound',
    contract: RuntimeThreadsV1,
    method: 'get',
    args: (context) => [child(context)],
  },
  {
    label: 'list with one child',
    phase: 'bound',
    contract: RuntimeThreadsV1,
    method: 'list',
    args: () => [10],
  },
  {
    label: 'list with a cursor past the child',
    phase: 'bound',
    contract: RuntimeThreadsV1,
    method: 'list',
    args: (context) => [10, child(context)],
  },
  {
    label: 'get an unknown Thread',
    phase: 'bound',
    contract: RuntimeThreadsV1,
    method: 'get',
    args: () => [unknown],
  },
  {
    label: 'events of an unknown Thread',
    phase: 'bound',
    contract: RuntimeThreadsV1,
    method: 'events',
    args: () => [unknown, 0, 10],
  },
  {
    label: 'send to an unknown Thread',
    phase: 'bound',
    contract: RuntimeThreadsV1,
    method: 'send',
    args: () => [unknown, 'hello'],
  },
  {
    label: 'interrupt a child that is not running',
    phase: 'bound',
    contract: RuntimeThreadsV1,
    method: 'interrupt',
    args: (context) => [child(context), context.childPrompt as string],
  },
  {
    label: 'interrupt an unknown Thread',
    phase: 'bound',
    contract: RuntimeThreadsV1,
    method: 'interrupt',
    args: () => [unknown, unknown],
  },
  {
    label: 'terminate an unknown Thread',
    phase: 'bound',
    contract: RuntimeThreadsV1,
    method: 'terminate',
    args: () => [unknown],
  },
  {
    label: 'terminate the child',
    phase: 'bound',
    contract: RuntimeThreadsV1,
    method: 'terminate',
    args: (context) => [child(context)],
  },
  {
    label: 'send to the terminated child',
    phase: 'bound',
    contract: RuntimeThreadsV1,
    method: 'send',
    args: (context) => [child(context), 'after'],
  },
  {
    label: 'interrupt the terminated child',
    phase: 'bound',
    contract: RuntimeThreadsV1,
    method: 'interrupt',
    args: (context) => [child(context), context.childPrompt as string],
  },
  {
    label: 'terminal run on a sandbox without live terminals',
    phase: 'bound',
    contract: TerminalV1,
    method: 'run',
    args: () => [terminalInput],
  },
  {
    label: 'list after the prompt ended',
    phase: 'ended',
    contract: RuntimeThreadsV1,
    method: 'list',
    args: () => [10],
  },
  {
    label: 'spawn after the prompt ended',
    phase: 'ended',
    contract: RuntimeThreadsV1,
    method: 'spawn',
    args: () => ['late'],
  },
  {
    label: 'cwd after the prompt ended',
    phase: 'ended',
    contract: RuntimeWorkspaceV1,
    method: 'cwd',
    args: () => [],
  },
  {
    label: 'describe after the prompt ended',
    phase: 'ended',
    contract: RuntimeLeaseV1,
    method: 'describe',
    args: () => [],
  },
  {
    label: 'exec after the prompt ended',
    phase: 'ended',
    contract: RuntimeLeaseV1,
    method: 'exec',
    args: () => [{ cmd: ['sh', '-c', 'true'] }],
  },
  {
    label: 'terminal run after the prompt ended',
    phase: 'ended',
    contract: TerminalV1,
    method: 'run',
    args: () => [terminalInput],
  },
  {
    label: 'terminal run on a facade without terminals',
    phase: 'no-terminals',
    contract: TerminalV1,
    method: 'run',
    args: () => [terminalInput],
  },
];

const outcomeOf = async (run: () => Promise<unknown>): Promise<Outcome> => {
  try {
    const value = await run();

    return value === undefined ? { void: true } : { value };
  } catch (error) {
    const failure = error as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
    };

    return {
      error: {
        name: String(failure.name),
        message: String(failure.message),
        ...(typeof failure.code === 'string' ? { code: failure.code } : {}),
      },
    };
  }
};

/** Runs the scenario on a driver and answers its raw (not normalized) steps. */
export const runScenario = async (
  driver: CaptureDriver,
): Promise<readonly TranscriptStep[]> => {
  const scope = await driver.start();
  const context: Context = { scope };
  const steps: TranscriptStep[] = [];
  let phase: Phase = 'bound';
  let release: (() => void) | undefined;

  for (const step of scenario) {
    if (phase === 'bound' && step.phase !== 'bound') await driver.end();

    if (step.phase === 'no-terminals' && release === undefined)
      release = driver.bindWithoutTerminals(scope);

    phase = step.phase;

    const args = step.args(context);
    const api = driver.services.use(step.contract, scope) as unknown as Record<
      string,
      (...values: unknown[]) => Promise<unknown>
    >;
    const outcome = await outcomeOf(() =>
      (api[step.method] as (...values: unknown[]) => Promise<unknown>)(
        ...args,
        driver.call(scope),
      ),
    );

    if ('value' in outcome) step.keep?.(context, outcome.value);

    const settled = step.settle?.(context);

    if (settled !== undefined) await driver.settle(...settled);

    steps.push({
      label: step.label,
      phase: step.phase,
      contract: step.contract.id,
      method: step.method,
      args,
      outcome,
    });
  }

  release?.();

  return steps;
};

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const measured = new Set(['lastExecutionMs', 'durationMs']);

/**
 * Replaces each UUID with `<id:n>` by first appearance (the fixed unknown id
 * stays), each ISO timestamp with `<time>` and each measured duration with
 * `<ms>`, so two runs of the same scenario compare equal.
 */
export const normalize = <T>(value: T): T => {
  const ids = new Map<string, string>();
  const name = (id: string): string => {
    if (id === setup.unknownId) return id;

    let named = ids.get(id);

    if (named === undefined) {
      named = `<id:${ids.size + 1}>`;
      ids.set(id, named);
    }

    return named;
  };
  const walk = (entry: unknown, key?: string): unknown => {
    if (typeof entry === 'string')
      return iso.test(entry) ? '<time>' : entry.replace(uuid, name);
    if (typeof entry === 'number')
      return key !== undefined && measured.has(key) ? '<ms>' : entry;
    if (Array.isArray(entry)) return entry.map((item) => walk(item));
    if (typeof entry === 'object' && entry !== null)
      return Object.fromEntries(
        Object.entries(entry).map(([field, item]) => [
          field,
          walk(item, field),
        ]),
      );

    return entry;
  };

  return JSON.parse(JSON.stringify(walk(JSON.parse(JSON.stringify(value)))));
};

export const transcriptOf = (steps: readonly TranscriptStep[]): Transcript => ({
  version: 1,
  source: 'host-adapter',
  setup,
  steps: normalize(steps),
});

export const readTranscript = async (): Promise<Transcript> =>
  JSON.parse(await readFile(transcriptPath, 'utf8')) as Transcript;

// The kernel recording ------------------------------------------------------

interface KernelWorkspace {
  readonly dependencies: Record<string, unknown>;
}

interface KernelService {
  readonly projects: {
    create(name: string): Promise<{ readonly id: string }>;
    find(id: string): Promise<{ readonly state: string } | undefined>;
  };
  readonly threads: {
    create(
      projectId: string,
      name: string,
    ): Promise<{ readonly status: string; readonly thread: { id: string } }>;
    prompt(id: string, prompt: string): Promise<unknown>;
    find(id: string): Promise<
      | {
          readonly state: string;
          readonly activePromptId?: string;
          readonly result?: { readonly promptId: string };
        }
      | undefined
    >;
    queue(id: string): Promise<{ readonly items: readonly unknown[] }>;
  };
  dispose(): Promise<void>;
}

interface ExecutionInput {
  readonly thread: { readonly id: string; readonly projectId: string };
  readonly job: { readonly id: string; readonly prompt: string };
  readonly sandbox: unknown;
  readonly host: {
    readonly threads: unknown;
    readonly workspace: unknown;
    readonly terminals?: unknown;
  };
}

interface KernelModules {
  readonly createWorkspaceService: (options: unknown) => KernelService;
  readonly createProjectStore: (database: unknown) => unknown;
  readonly createThreadStore: (database: unknown) => unknown;
  readonly createHostAdapter: () => {
    readonly bundle: {
      readonly host?: { activate(context: HostContext): unknown };
    };
    attach(scope: CallScope, binding: unknown): () => void;
  };
  readonly workspace: () => KernelWorkspace;
  readonly pool: (release: undefined, sandbox: unknown) => unknown;
  readonly fakeSandbox: (options: unknown) => Record<string, unknown>;
  readonly persistenceFixture: (url: string) => Promise<{
    readonly database: unknown;
    close(): Promise<void>;
  }>;
}

const kernelModules = async (root: string): Promise<KernelModules> => {
  const load = async (path: string) =>
    (await import(pathToFileURL(join(root, path)).href)) as Record<
      string,
      unknown
    >;
  const base = 'agents/doric/dist-tests';

  return {
    ...(await load(`${base}/src/lib/workspace/service.js`)),
    ...(await load(`${base}/src/lib/workspace/projects.js`)),
    ...(await load(`${base}/src/lib/workspace/threads.js`)),
    ...(await load(`${base}/src/lib/bundles/adapter.js`)),
    ...(await load(`${base}/tests/helpers/workspace.js`)),
    ...(await load(`${base}/tests/helpers/persistence-fixture.js`)),
  } as unknown as KernelModules;
};

const waitUntil = async (
  check: () => Promise<boolean>,
  what: string,
): Promise<void> => {
  const deadline = Date.now() + 10_000;

  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${what}.`);

    await new Promise((done) => setTimeout(done, 10));
  }
};

/**
 * The recording driver: the kernel WorkspaceService over Prisma stores on a
 * fresh PostgreSQL schema, a scripted sandbox, and the stage-1 adapter's
 * services behind the test dispatcher.
 */
export const kernelDriver = async (
  databaseUrl: string,
  root = process.cwd(),
): Promise<CaptureDriver> => {
  const kernel = await kernelModules(root);
  const fixture = await kernel.persistenceFixture(databaseUrl);
  const written = new Map<string, string>();
  const scripted = kernel.fakeSandbox(setup.sandbox);
  const sandbox = {
    ...scripted,
    readFile: async (path: string) =>
      written.get(path) ??
      (scripted.readFile as (path: string) => Promise<string>)(path),
    writeFile: async (path: string, content: string) => {
      written.set(path, content);
    },
  };
  const adapter = kernel.createHostAdapter();
  const definitions: AnyServiceDefinition[] = [];

  adapter.bundle.host?.activate({
    services: {
      provide: (definition: AnyServiceDefinition) => {
        definitions.push(definition);
      },
    },
  } as unknown as HostContext);

  const harness = createTestServices({
    bundle: { id: 'capture' },
    provide: definitions,
  });
  const helper = kernel.workspace();
  let bound:
    | ((value: { scope: CallScope; input: ExecutionInput }) => void)
    | undefined;
  const started = new Promise<{ scope: CallScope; input: ExecutionInput }>(
    (done) => {
      bound = done;
    },
  );
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((done) => {
    finish = done;
  });
  let released = false;
  const service = kernel.createWorkspaceService({
    ...helper.dependencies,
    projects: kernel.createProjectStore(fixture.database),
    threads: kernel.createThreadStore(fixture.database),
    pool: kernel.pool(undefined, sandbox),
    execute: async (input: ExecutionInput) => {
      if (input.job.prompt !== setup.parentPrompt)
        return `${setup.childResultPrefix}${input.job.prompt}`;

      const scope = {
        projectId: input.thread.projectId,
        threadId: input.thread.id,
        promptId: input.job.id,
      };
      const release = adapter.attach(scope, {
        host: input.host,
        sandbox: input.sandbox,
      });

      bound?.({ scope, input });

      try {
        await finished;
      } finally {
        release();
        released = true;
      }

      return 'parent done';
    },
  });
  let parent: { scope: CallScope; input: ExecutionInput } | undefined;

  return {
    services: harness.services,
    call: (scope) => harness.call(scope),
    start: async () => {
      const project = await service.projects.create(setup.project);

      await waitUntil(
        async () =>
          (await service.projects.find(project.id))?.state === 'ready',
        'the Project',
      );

      const created = await service.threads.create(
        project.id,
        setup.parentThread,
      );

      await service.threads.prompt(created.thread.id, setup.parentPrompt);
      parent = await started;

      return parent.scope;
    },
    settle: (threadId, promptId) =>
      waitUntil(async () => {
        const thread = await service.threads.find(threadId);
        const queue = await service.threads.queue(threadId);

        return (
          thread?.state === 'ready' &&
          thread.activePromptId === undefined &&
          thread.result?.promptId === promptId &&
          queue.items.length === 0
        );
      }, `Thread ${threadId}`),
    end: async () => {
      finish?.();
      await waitUntil(async () => released, 'the parent release');
    },
    bindWithoutTerminals: (scope) =>
      adapter.attach(scope, {
        host: {
          threads: parent?.input.host.threads,
          workspace: parent?.input.host.workspace,
        },
        sandbox: parent?.input.sandbox,
      }),
    dispose: async () => {
      await service.dispose();
      await harness.dispose();
      await fixture.close();
    },
  };
};

/** Records the transcript from the kernel adapter and writes the fixture. */
export const recordTranscript = async (
  databaseUrl: string,
): Promise<Transcript> => {
  const driver = await kernelDriver(databaseUrl);

  try {
    return transcriptOf(await runScenario(driver));
  } finally {
    await driver.dispose();
  }
};

const main = async (): Promise<void> => {
  const url = process.env.DORIC_TEST_DATABASE_URL;

  if (url === undefined)
    throw new Error('DORIC_TEST_DATABASE_URL is required.');

  const transcript = await recordTranscript(url);

  await writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`);
};

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
