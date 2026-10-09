// Fixtures for the real-process tests: a kernel booted with the embedded
// minimal core and installed plain-JS bundles that run in a forked
// generation process (the compiled `runner-main.js`).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  EmbeddedBundle,
  GenerationLease,
  KernelPlatform,
} from '../../src/index.js';
import { startKernel } from '../../src/index.js';
import {
  type CapturedLog,
  type CapturedSink,
  captureLog,
  captureSink,
  contractsUrl,
  descriptorFor,
  manifest,
  writeBundle,
} from './fixtures.js';
import { minimalCore } from './minimal-core.js';

/** File URL of the zod module the tests load, for plain-JS bundles in a temp dir. */
export const zodUrl = import.meta.resolve('zod');

export interface ProbeOptions {
  /** Registers the `probe` tool (tools/v1). */
  readonly tool?: boolean;
  /** Version written in the manifest (a new generation may change it). */
  readonly version?: string;
}

/**
 * Host part of the `probe` bundle: `probe/v1` answers who and where it runs,
 * holds executions through `doric.generation/v1`, answers `wait` late; the optional `probe` tool
 * reports its process and generation, or blocks until the process dies.
 */
export const probeSource = (options: ProbeOptions = {}) => `
import { z } from ${JSON.stringify(zodUrl)};
import {
  bindRegistrant,
  defineMethod,
  defineService,
  DoricBundleV1,
  DoricGenerationV1,
  ref,
  ToolsV1,
} from ${JSON.stringify(contractsUrl)};

const ProbeV1 = ref('probe/v1');
const holds = [];

export const activate = ({ services }) => {
  services.provide(
    defineService(ProbeV1, {
      describe: defineMethod({
        input: z.tuple([]),
        output: z.looseObject({}),
        execute: async (_input, call) => ({
          bundle: await services.use(DoricBundleV1).describe(call),
          generation: await services.use(DoricGenerationV1).describe(call),
          pid: process.pid,
        }),
      }),
      hold: defineMethod({
        input: z.string(),
        output: z.null(),
        execute: (promptId, call) => {
          holds.push(
            services
              .use(DoricGenerationV1)
              .hold({ projectId: 'p', threadId: 't', promptId }, call),
          );

          return null;
        },
      }),
      wait: defineMethod({
        input: z.number(),
        output: z.number(),
        execute: async (ms) => {
          await new Promise((resolve) => setTimeout(resolve, ms));

          return process.pid;
        },
      }),
      releaseAll: defineMethod({
        input: z.tuple([]),
        output: z.null(),
        execute: () => {
          for (const held of holds.splice(0)) {
            held.dispose();
          }

          return null;
        },
      }),
    }),
  );
${
  options.tool === true
    ? `
  const definition = {
    name: 'probe',
    description: 'Reports where it runs.',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
  };

  services.use(ToolsV1).register(
    {
      name: 'probe',
      definition,
      [bindRegistrant]: (bound) => ({
        name: 'probe',
        description: 'Reports where it runs.',
        definition,
        input: z.object({ block: z.boolean().optional() }),
        output: z.unknown(),
        settings: [],
        execute: async (payload, call) => {
          if (payload.block === true) {
            await new Promise(() => undefined);
          }

          const described = await bound.use(DoricBundleV1).describe(call);

          return { pid: process.pid, generation: described.generation };
        },
      }),
    },
    { alwaysAvailable: true },
  );
`
    : ''
}};
`;

const probeManifest = (options: ProbeOptions) =>
  manifest('probe', {
    ...(options.version === undefined ? {} : { version: options.version }),
    provides: ['probe/v1@1.0.0'],
    requires: options.tool === true ? ['tools/v1@^1.0.0'] : [],
  });

/** Writes (or rewrites) the installed `probe` bundle. */
export const writeProbe = async (
  root: string,
  options: ProbeOptions = {},
): Promise<string> => {
  const source = probeManifest(options);

  return await writeBundle(join(root, 'bundles'), 'probe', {
    manifest: source,
    descriptor: descriptorFor(source),
    host: probeSource(options),
  });
};

/** A bundle that registers a tool named `probe` too (a duplicate name). */
export const writeDuplicateTool = async (root: string): Promise<string> => {
  const source = manifest('dupe', { requires: ['tools/v1@^1.0.0'] });

  return await writeBundle(join(root, 'bundles'), 'dupe', {
    manifest: source,
    descriptor: descriptorFor(source),
    host: `
import { z } from ${JSON.stringify(zodUrl)};
import { bindRegistrant, ToolsV1 } from ${JSON.stringify(contractsUrl)};

const definition = { name: 'probe', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } };

export const activate = ({ services }) => {
  services.use(ToolsV1).register(
    {
      name: 'probe',
      definition,
      [bindRegistrant]: () => ({
        name: 'probe',
        definition,
        input: z.object({}),
        output: z.unknown(),
        settings: [],
        execute: async () => ({}),
      }),
    },
    { alwaysAvailable: false },
  );
};
`,
  });
};

/** A bundle whose activation ends its process: its generation never starts. */
export const writeCrashOnActivate = async (root: string): Promise<string> => {
  const source = manifest('crasher');

  return await writeBundle(join(root, 'bundles'), 'crasher', {
    manifest: source,
    descriptor: descriptorFor(source),
    host: 'export const activate = () => { process.exit(1); };\n',
  });
};

export interface Kernel {
  readonly platform: KernelPlatform;
  readonly log: CapturedLog;
  readonly sink: CapturedSink;
  readonly compositionPath: string;
}

/** Boots a kernel over `root` with the embedded minimal core. */
export const bootKernel = async (
  root: string,
  enabled: readonly string[],
  options: {
    readonly startAttempts?: number;
    readonly stopTimeoutMs?: number;
    readonly embedded?: readonly EmbeddedBundle[];
  } = {},
): Promise<Kernel> => {
  const bundlesPath = join(root, 'bundles');
  const compositionPath = join(root, 'composition.json');
  const log = captureLog();
  const sink = captureSink();

  await mkdir(bundlesPath, { recursive: true });
  await writeComposition(compositionPath, enabled);

  const platform = await startKernel({
    bundlesPath,
    composition: { path: compositionPath },
    log,
    sink,
    ...options,
    embedded: [minimalCore(), ...(options.embedded ?? [])],
  });

  return { platform, log, sink, compositionPath };
};

export const writeComposition = async (
  path: string,
  enabled: readonly string[],
): Promise<void> => {
  await writeFile(
    path,
    JSON.stringify({ core: 'mincore', enabled: ['mincore', ...enabled] }),
  );
};

/** Whether a process exists. */
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

/** Polls until `check` holds (processes and IPC are asynchronous). */
export const eventually = async (
  check: () => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<void> => {
  const started = Date.now();

  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for: ${what}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

export const execution = (promptId: string) => ({
  projectId: 'project',
  threadId: 'thread',
  promptId,
});

export const acquire = (
  platform: KernelPlatform,
  promptId: string,
): Promise<GenerationLease> =>
  platform.generations.acquire(
    execution(promptId),
    new AbortController().signal,
  );
