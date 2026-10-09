import { join } from 'node:path';

import {
  type EmbeddedBundle,
  type HostPlatform,
  type LogSink,
  type PlatformLog,
  type Skill,
  startHost,
} from 'bundle';
import { SkillsV1, ToolsV1 } from 'bundle/contracts';
import type { Logger } from 'pino';
import { type BoundTool, isBoundTool } from 'tool';

import type { HostAdapter } from './adapter.js';

/** What the Direct agent reads from the bundles: every tool and skill, in order. */
export interface BundleCatalog {
  readonly tools: readonly BoundTool[];
  readonly skills: readonly Skill[];
}

export interface Bundles {
  readonly platform: HostPlatform;
  readonly catalog: BundleCatalog;
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

/**
 * Boots the host's bundles: the installed bundles below `bundlesPath`, the
 * composition at `compositionPath`, the embedded host adapter and any further
 * embedded bundles. Activation opens no database. It returns
 * the platform and the tools and skills the Direct agent binds on every
 * prompt, read once, because bundles never change while the process runs.
 */
export const startBundles = async ({
  bundlesPath,
  compositionPath,
  adapter,
  embedded = [],
  logger,
}: StartBundlesOptions): Promise<Bundles> => {
  const platform = await startHost({
    bundlesPath,
    composition: { path: compositionPath },
    embedded: [adapter.bundle, ...embedded],
    log: platformLog(logger.child({ component: 'platform' })),
    sink: pinoSink(logger.child({ component: 'bundles' })),
  });

  if (platform.mode === 'recovery') {
    const reason = platform.diagnostics().recovery?.reason;

    await platform.stop();
    throw new BundleRecoveryError(reason);
  }

  const tools = platform.services
    .use(ToolsV1)
    .list()
    .map(({ tool }) => {
      if (!isBoundTool(tool))
        throw new TypeError(
          `Tool "${tool.name}" was not defined with defineTool.`,
        );
      return tool;
    });
  const skills = (await platform.services.use(SkillsV1).list()).map(
    ({ skill }) => skill,
  );
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
    catalog: { tools, skills },
    bundleCount: installed.size,
  };
};
