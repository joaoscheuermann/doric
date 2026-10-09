import { join } from 'node:path';

import {
  type EmbeddedBundle,
  type ExecutionRef,
  type KernelPlatform,
  type LogSink,
  type PlatformLog,
  type Skill,
  startKernel,
} from 'bundle';
import {
  type Call,
  type CallScope,
  type RegisteredTool,
  SkillsV1,
  ToolsV1,
} from 'bundle/contracts';
import type { Logger } from 'pino';
import { type BoundTool, isBoundTool, ToolErrorObject } from 'tool';

import type { HostAdapter } from './adapter.js';

/** What the Direct agent reads from the bundles: every tool and skill, in order. */
export interface BundleCatalog {
  readonly tools: readonly BoundTool[];
  readonly skills: readonly Skill[];
}

/**
 * One prompt run pinned to a bundle generation: the call its tools run under
 * and the tools and skills that generation registered. The run keeps it until
 * it ends or pauses, so a published generation never changes a running prompt.
 */
export interface BundleLease {
  readonly generation: number;
  readonly call: (scope: CallScope, signal: AbortSignal) => Call;
  readonly tools: (call: Call) => readonly BoundTool[];
  readonly skills: (call: Call) => Promise<readonly Skill[]>;
  /** Idempotent. */
  release(): void;
}

export interface Bundles {
  readonly platform: KernelPlatform;
  /** The tools and skills of the active generation, for configuration and GET /tools. */
  readonly catalog: () => BundleCatalog;
  /** Pins one prompt run to the active generation, waiting (abortably) for one. */
  readonly acquire: (
    execution: ExecutionRef,
    signal: AbortSignal,
  ) => Promise<BundleLease>;
  /** Installed bundles the host activated. */
  readonly bundleCount: number;
}

/**
 * The core (or a chosen foundation provider) could not activate, so the host
 * is in recovery mode. In stage 1 the host has no recovery surface of its own;
 * the boot ends in its fatal startup path after the platform log recorded each
 * bundle and its reasons.
 */
export class BundleRecoveryError extends Error {
  constructor(reason: string | undefined) {
    super(`Bundle recovery mode: ${reason ?? 'unknown reason'}`);
    this.name = 'BundleRecoveryError';
  }
}

export interface StartBundlesOptions {
  readonly bundlesPath: string;
  readonly compositionPath: string;
  readonly adapter: HostAdapter;
  /** Further embedded bundles, such as the configuration owner `host-config`. */
  readonly embedded?: readonly EmbeddedBundle[];
  readonly logger: Logger;
}

/**
 * Where the host reads its bundles and composition: `DORIC_BUNDLES_PATH` and
 * `DORIC_COMPOSITION`, or else the staged `dist/bundles` beside the compiled
 * entrypoint and the composition the host ships, `agents/doric/composition.json`.
 */
export const bundlePaths = (
  environment: Readonly<Record<string, string | undefined>>,
  entrypointDirectory: string,
): { readonly bundlesPath: string; readonly compositionPath: string } => ({
  bundlesPath:
    environment.DORIC_BUNDLES_PATH ??
    join(entrypointDirectory, '..', 'bundles'),
  compositionPath:
    environment.DORIC_COMPOSITION ??
    join(entrypointDirectory, '..', '..', 'composition.json'),
});

/** Writes `doric.log/v1` records into the host's own pino destinations. */
export const pinoSink = (logger: Logger): LogSink => ({
  write: ({ level, message, fields, ...origin }) => {
    logger[level](
      { ...origin, ...(fields === undefined ? {} : { fields }) },
      message,
    );
  },
});

const platformLog = (logger: Logger): PlatformLog => ({
  info: (fields, message) => logger.info(fields, message),
  warn: (fields, message) => logger.warn(fields, message),
  error: (fields, message) => logger.error(fields, message),
});

const boundTools = (tools: readonly RegisteredTool[]): readonly BoundTool[] =>
  tools.map(({ tool }) => {
    if (!isBoundTool(tool))
      throw new TypeError(
        `Tool "${tool.name}" was not defined with defineTool.`,
      );
    return tool;
  });

/**
 * Boots the host's bundles through the kernel: the foundation, the core and the
 * embedded bundles (the host adapter and any further ones) run in this
 * process, and the installed bundles run in a generation process the kernel
 * forks. Activation opens no database. It returns the platform, the catalog of
 * the active generation and how a prompt pins itself to one.
 */
export const startBundles = async ({
  bundlesPath,
  compositionPath,
  adapter,
  embedded = [],
  logger,
}: StartBundlesOptions): Promise<Bundles> => {
  const platform = await startKernel({
    bundlesPath,
    composition: { path: compositionPath },
    embedded: [adapter.bundle, ...embedded],
    log: platformLog(logger.child({ component: 'platform' })),
    sink: pinoSink(logger.child({ component: 'bundles' })),
    errorClasses: [ToolErrorObject],
  });

  if (platform.mode === 'recovery') {
    const reason = platform.diagnostics().recovery?.reason;

    await platform.stop();
    throw new BundleRecoveryError(reason);
  }

  const tools = platform.services.use(ToolsV1);
  const skillsOf = async (call?: Call): Promise<readonly Skill[]> => {
    const skills = platform.services.use(SkillsV1);
    // An explicit `undefined` would be one argument more than `list` accepts.
    const listed = await (call === undefined
      ? skills.list()
      : skills.list(call));

    return listed.map(({ skill }) => skill);
  };
  // Skills are read asynchronously, so the active generation's are kept from
  // the moment it became active; tools are read on every call.
  let skills: {
    readonly generation: number;
    readonly skills: readonly Skill[];
  };
  try {
    skills = { generation: platform.generation, skills: await skillsOf() };
  } catch (error) {
    await platform.stop();
    throw error;
  }

  platform.generations.onActive((generation) => {
    void skillsOf(platform.call({ generation })).then(
      (value) => {
        if (generation >= skills.generation)
          skills = { generation, skills: value };
      },
      (error: unknown) => {
        logger.error({ err: error, generation }, 'Bundle skills unreadable');
      },
    );
  });

  const installed = new Set(
    platform
      .catalog()
      .bundles.filter(({ state }) => state === 'active')
      .map(({ id }) => id),
  );

  for (const { manifest } of [adapter.bundle, ...embedded])
    installed.delete(manifest.id);

  return {
    platform,
    catalog: () => ({ tools: boundTools(tools.list()), skills: skills.skills }),
    acquire: async (execution, signal) => {
      const lease = await platform.generations.acquire(execution, signal);

      return {
        generation: lease.generation,
        call: (scope, callSignal) => lease.call({ scope, signal: callSignal }),
        tools: (call) => boundTools(tools.list(call)),
        skills: (call) => skillsOf(call),
        release: () => lease.release(),
      };
    },
    bundleCount: installed.size,
  };
};

/** What the workspace does when a generation process exits under its prompts. */
export interface GenerationLossHandler {
  suspendForGenerationLoss(executions: readonly ExecutionRef[]): void;
  resumeAfterGenerationLoss(): Promise<void>;
}

/**
 * Wires the workspace to the kernel's generations: a generation process that
 * exits under running prompts pauses them, as a host crash would, and the
 * active generation takes them up again — at once when the lost one was
 * draining, otherwise once its respawn is active. Returns the unsubscriber.
 */
export const recoverGenerationLoss = (
  generations: KernelPlatform['generations'],
  handler: GenerationLossHandler,
): (() => void) => {
  const lost = generations.onLost((value) => {
    handler.suspendForGenerationLoss(value.executions);
    if (
      generations
        .describe()
        .some(
          ({ generation, state }) =>
            state === 'active' && generation !== value.generation,
        )
    )
      void handler.resumeAfterGenerationLoss();
  });
  const active = generations.onActive(() => {
    void handler.resumeAfterGenerationLoss();
  });

  return () => {
    lost();
    active();
  };
};
