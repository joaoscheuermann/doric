import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  type AlternativeChoices,
  type Composition,
  compositionOverridesPath,
  type EmbeddedBundle,
  enableAlternatives,
  enabledAlternatives,
  type KernelPlatform,
  type LogSink,
  type PlatformLog,
  readComposition,
  type StartupSink,
  selectAlternatives,
  startKernel,
  type Variables,
} from 'bundle';
import type { CatalogSnapshot, NetworkResources } from 'bundle/contracts';
import type { Logger } from 'pino';
import { ToolErrorObject } from 'tool';

import { createCatalogDistribution } from '../bridge/catalog.js';

export interface Bundles {
  readonly platform: KernelPlatform;
  /** Installed bundles the host activated (embedded ones excluded). */
  readonly bundleCount: number;
}

/**
 * The core (or a chosen foundation provider) could not activate, or a
 * structural provider is missing, so the host is in recovery mode. The host
 * has no recovery surface of its own; the boot ends in its fatal startup path
 * after the platform log recorded each bundle and its reasons.
 */
export class BundleRecoveryError extends Error {
  constructor(reason: string | undefined) {
    super(`Bundle recovery mode: ${reason ?? 'unknown reason'}`);
    this.name = 'BundleRecoveryError';
  }
}

export interface StartBundlesOptions {
  readonly network?: NetworkResources;
  readonly bundlesPath: string;
  readonly compositionPath: string;
  /**
   * The composition to boot in place of the file at `compositionPath`, such
   * as the shipped one with the alternatives the variables chose applied
   * (`hostComposition`, D10-9); its overrides still live beside
   * `compositionPath`.
   */
  readonly composition?: Composition | { readonly path: string };
  /**
   * The composition overrides the splash recovery actions persist (HR-6);
   * default `composition.overrides.json` beside the composition.
   */
  readonly compositionOverridesPath?: string;
  /** Optional embedded bundles, used by isolated hosts and tests. */
  readonly embedded?: readonly EmbeddedBundle[];
  readonly logger: Logger;
  /** Test seam: the generation runner the kernel forks. */
  readonly runnerPath?: string;
  /**
   * Random per host process [S8-22]: with the host generation, it names the
   * generation the desktop downloads through `doric.catalog/v1.distribution`.
   */
  readonly hostBoot?: string;
  /** The host's startup record: the stages and log lines of `doric.startup/v1`. */
  readonly startup?: StartupSink;
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
 * The contracts and bundles the host needs active before it serves, as its
 * composition declares them (`required`). Without them the host would run
 * without routes or without the operations its routes call.
 */
export type StructuralRequirement = NonNullable<Composition['required']>;

/** Only the composition defines which providers are essential. */
const noRequirements: StructuralRequirement = { contracts: [], bundles: [] };

/** Why the catalog cannot serve the host, or `undefined` when it can. */
export const structuralFault = (
  catalog: CatalogSnapshot,
  required: StructuralRequirement,
): string | undefined => {
  const active = new Set(
    catalog.bundles
      .filter(({ state }) => state === 'active')
      .map(({ id }) => id),
  );
  const missing = [
    ...required.contracts.filter(
      (id) =>
        !catalog.contracts.some(
          (contract) =>
            contract.id === id &&
            contract.providers.some(({ bundleId }) => active.has(bundleId)),
        ),
    ),
    ...required.bundles.filter((id) => !active.has(id)),
  ];

  return missing.length === 0
    ? undefined
    : `structural providers unavailable: ${missing.join(', ')}`;
};

/**
 * Refuses a host whose structural providers are not all active (design 57
 * §9.1, row 4b). Today any of them failing is a startup crash; a quarantine
 * must not leave a host without routes. The reasons are logged as the
 * recovery reason before the fatal path runs.
 */
export const assertStructural = async (
  platform: KernelPlatform,
  logger: Logger,
  required: StructuralRequirement,
): Promise<void> => {
  const reason = structuralFault(platform.catalog(), required);

  if (reason === undefined) return;

  logger.error({ reason }, 'Bundle recovery mode');
  await platform.stop();
  throw new BundleRecoveryError(reason);
};

/** The composition the host boots, with what the startup log says about it. */
export interface HostComposition {
  /**
   * What the kernel boots: the composition file, or the object with the chosen
   * alternatives enabled.
   */
  readonly composition: Composition | { readonly path: string };
  /** The option each alternative takes (`{ sandbox: 'docker' }`). */
  readonly alternatives: AlternativeChoices;
  readonly required: StructuralRequirement;
}

/**
 * Reads the composition the host boots and applies the alternatives its
 * variables choose (D10-9). Without `DORIC_COMPOSITION`, the shipped
 * composition boots with each chosen option enabled in place of its default
 * bundle; its overrides still live beside the file. An operator composition
 * is booted as written, and its enabled bundles say which option it uses. A
 * composition that cannot be read is left to the kernel, which refuses it at
 * `bundle_load`.
 */
export const hostComposition = async (
  variables: Variables,
  compositionPath: string,
): Promise<HostComposition> => {
  let composition: Composition;

  try {
    composition = await readComposition(compositionPath);
  } catch {
    return {
      composition: { path: compositionPath },
      alternatives: {},
      required: noRequirements,
    };
  }

  if (variables.DORIC_COMPOSITION !== undefined)
    return {
      composition: { path: compositionPath },
      alternatives: enabledAlternatives(composition),
      required: composition.required ?? noRequirements,
    };

  const alternatives = selectAlternatives(composition, variables);
  const changed = Object.entries(alternatives).some(
    ([name, option]) => option !== composition.alternatives?.[name]?.default,
  );

  return {
    composition: changed
      ? enableAlternatives(composition, alternatives)
      : { path: compositionPath },
    alternatives,
    required: composition.required ?? noRequirements,
  };
};

/**
 * Boots the host's bundles through the kernel: the foundation, the core and
 * the embedded bundles run in this process, and the installed bundles run in
 * a generation process the kernel forks. It resolves once generation 1 is
 * active or failed. Activation opens no database.
 */
export const startBundles = async ({
  bundlesPath,
  compositionPath,
  composition = { path: compositionPath },
  compositionOverridesPath: overridesPath = compositionOverridesPath(
    compositionPath,
  ),
  embedded = [],
  logger,
  runnerPath,
  hostBoot = randomUUID(),
  startup,
  network,
}: StartBundlesOptions): Promise<Bundles> => {
  const platform = await startKernel({
    bundlesPath,
    composition,
    compositionOverrides: overridesPath,
    embedded,
    log: platformLog(logger.child({ component: 'platform' })),
    sink: pinoSink(logger.child({ component: 'bundles' })),
    errorClasses: [ToolErrorObject],
    distribution: (source) => createCatalogDistribution({ source, hostBoot }),
    ...(runnerPath === undefined ? {} : { runnerPath }),
    ...(startup === undefined ? {} : { startup }),
    ...(network === undefined ? {} : { network }),
  });

  if (platform.mode === 'recovery') {
    const reason = platform.diagnostics().recovery?.reason;

    await platform.stop();
    throw new BundleRecoveryError(reason);
  }

  const installed = new Set(
    platform
      .catalog()
      .bundles.filter(({ state }) => state === 'active')
      .map(({ id }) => id),
  );

  for (const { manifest } of embedded) installed.delete(manifest.id);

  return { platform, bundleCount: installed.size };
};

/**
 * A structural provider lost after boot (cross-review G-5): the generation
 * that held `runtime` or `direct` exhausted its respawns and the kernel
 * activated an empty view. The host takes its fatal path, as a boot without
 * those providers does, so the supervisor restarts it as it did when the
 * process died. Returns the unsubscriber.
 */
export const watchStructural = (
  platform: KernelPlatform,
  logger: Logger,
  fatal: (reason: string) => void,
  required: StructuralRequirement,
): (() => void) =>
  platform.generations.onActive(() => {
    const reason = structuralFault(platform.catalog(), required);

    if (reason === undefined) return;

    logger.error({ reason }, 'Bundle recovery mode');
    fatal(reason);
  });
