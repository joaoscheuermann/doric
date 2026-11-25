import { join } from 'node:path';

import {
  type AlternativeChoices,
  applyCompositionOverrides,
  buildCatalog,
  type Composition,
  compositionOverridesPath,
  compositionSchema,
  discoverBundles,
  enableAlternatives,
  enabledAlternatives,
  type InstalledBundle,
  PLATFORM_VERSION,
  readComposition,
  readCompositionOverrides,
  type StartupSink,
  selectAlternatives,
  type Variables,
} from 'bundle';
import { SkillsService } from 'bundle/contracts/gen/doric/skills/v1/skills_pb.js';
import { ToolsService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import {
  type Platform,
  type PlatformOptions,
  readStagedCatalogIndex,
  runHostHook,
  stagedCommandOf,
  stagedHostPart,
  startPlatform,
  withBasicContracts,
} from 'bundle/platform';
import { DiagnosticsStore, type ResolvedEnvironment } from 'bundle/runtime';
import type { Logger } from 'pino';

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

/**
 * Where the host reads its bundles and composition: `DORIC_BUNDLES_PATH` and
 * `DORIC_COMPOSITION`, or else the staged `dist/bundles` beside the compiled
 * entrypoint and the composition the host ships, `app/backend/doric-host/composition.json`.
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

/**
 * The contracts and bundles the host needs active before it serves, as its
 * composition declares them (`required`). Without them the host would run
 * without routes or without the operations its routes call.
 */
export type StructuralRequirement = NonNullable<Composition['required']>;

/** Only the composition defines which providers are essential. */
const noRequirements: StructuralRequirement = { contracts: [], bundles: [] };

/** The composition the host boots, with what the startup log says about it. */
export interface HostComposition {
  /**
   * What `startHostPlatform` boots: the composition file, or the object with
   * the chosen alternatives enabled.
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
 * composition that cannot be read is answered as its path, with no
 * alternatives and no requirements: `startHostPlatform` reads it again and
 * rejects with `BundleRecoveryError` (`invalid composition: ...`) before any
 * bundle process starts.
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

/** The booted host: the platform and what the host read to boot it. */
export interface HostPlatform {
  readonly platform: Platform;
  /** The host resolution the platform booted (generation 1). */
  readonly resolved: ResolvedEnvironment;
  readonly diagnostics: DiagnosticsStore;
}

export interface StartHostPlatformOptions {
  /** The staged bundles (`bundlePaths`); each `<id>/` holds `manifest.json`, `contracts.json`, `descriptors.binpb`, `host/`. */
  readonly bundlesPath: string;
  /** The composition file; its overrides (`composition.overrides.json`) live beside it. */
  readonly compositionPath: string;
  /** What to boot instead of the file, as `hostComposition` answers it. */
  readonly composition: Composition | { readonly path: string };
  /** `hostComposition(...).required`: the structural providers. */
  readonly required: StructuralRequirement;
  /** `<DORIC_HOST>:<DORIC_PORT>` (`0.0.0.0:3000` by default). */
  readonly publicAddress: string;
  /** The host's stage tracker and its `component: 'startup'` lines (`doric.startup/v1`). */
  readonly startup: StartupSink;
  /** The host logger: `doric.log/v1` records (`component: 'bundles'`), `Bundles loaded`, `Bundle recovery mode`. */
  readonly logger: Logger;
  /** Ends the host after a later required quarantine; `process.exit` when undefined. */
  readonly exit?: PlatformOptions['exit'];
  /** The instances' base environment; `process.env` when undefined. */
  readonly env?: NodeJS.ProcessEnv;
}

/** The generation the host boots: the first. */
const bootGeneration = 1;

/** The levels of `doric.log/v1`, each a method of the host logger. */
const logLevels = new Set(['debug', 'info', 'warn', 'error'] as const);

type LogLevel = typeof logLevels extends Set<infer Level> ? Level : never;

const isLogLevel = (level: string): level is LogLevel =>
  logLevels.has(level as LogLevel);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The composition the host boots as written, without overrides: the file
 * read, or the object `hostComposition` answered, validated.
 */
const readBootComposition = async (
  composition: StartHostPlatformOptions['composition'],
): Promise<Composition> =>
  'path' in composition
    ? await readComposition(composition.path)
    : compositionSchema.parse(composition);

/**
 * The host resolution of generation `generation`: the staged bundles
 * discovered, the composition read (`readBootComposition`) with its
 * overrides applied. Discovery and overrides problems become catalog
 * issues; a composition that cannot be read is answered as the `reason` of
 * a recovery.
 */
const readHostResolution = async (
  options: Pick<
    StartHostPlatformOptions,
    'bundlesPath' | 'compositionPath' | 'composition'
  > & { readonly generation: number },
): Promise<ResolvedEnvironment | { readonly reason: string }> => {
  const issues: string[] = [];
  let installed: readonly InstalledBundle[] = [];
  let composition: Composition;

  try {
    installed = await discoverBundles(options.bundlesPath);
  } catch (error) {
    issues.push(messageOf(error));
  }

  try {
    composition = await readBootComposition(options.composition);
  } catch (error) {
    return { reason: `invalid composition: ${messageOf(error)}` };
  }

  try {
    composition = applyCompositionOverrides(
      composition,
      await readCompositionOverrides(
        compositionOverridesPath(options.compositionPath),
      ),
    );
  } catch (error) {
    issues.push(messageOf(error));
  }

  return buildCatalog({
    installed,
    embedded: [],
    composition,
    platformVersion: PLATFORM_VERSION,
    generation: options.generation,
    issues,
  });
};

/**
 * Flows → Boot up to the bound public listener (spec `:1526`): reads the
 * composition with its overrides applied, discovers the staged bundles and
 * resolves the host environment (generation 1), indexes their
 * `descriptors.binpb` (`readStagedCatalogIndex`), and starts the platform with
 * `stagedCommandOf(bundlesPath)` and `stagedHostPart(bundlesPath)`, so
 * client-only bundles are active and never spawned. Before the listener
 * binds it logs `Bundles loaded` `{bundleCount, skillCount, toolCount}`
 * (`bundleCount`: the catalog's active entries; the counts from
 * `skills/v1.List` and `tools/v1.List` as `doric`), then runs
 * `onHostStartHook` (`runHostHook`); at shutdown it runs `onHostStopHook`
 * within the platform's deadline.
 *
 * Resolves once the public listener listens. Rejects with
 * `BundleRecoveryError(platform.structuralFault)` after logging
 * `Bundle recovery mode` `{reason}` and shutting the platform down, when a
 * structural provider is not active after the boot; with the platform's
 * rejection otherwise (`RouterBindingError`, `PublicListenerBindingError`,
 * the storage identity's `ContractError`, a failing `onHostStartHook`), after
 * the platform shut down what started. Nothing is left running on a
 * rejection. Never runs `onHostReadyHook` (see {@link hostReady}).
 */
export const startHostPlatform = async (
  options: StartHostPlatformOptions,
): Promise<HostPlatform> => {
  const { bundlesPath, startup } = options;
  const startupLog = options.logger.child({ component: 'startup' });
  const bundlesLog = options.logger.child({ component: 'bundles' });
  const recovery = (reason: string): BundleRecoveryError => {
    startupLog.error({ reason }, 'Bundle recovery mode');

    return new BundleRecoveryError(reason);
  };
  const resolved = await readHostResolution({
    ...options,
    generation: bootGeneration,
  });

  if ('reason' in resolved) throw recovery(resolved.reason);
  if (resolved.recovery !== undefined) throw recovery(resolved.recovery.reason);

  const diagnostics = new DiagnosticsStore({ generation: bootGeneration });

  diagnostics.load(resolved);

  const index = withBasicContracts(
    await readStagedCatalogIndex(
      bundlesPath,
      resolved.entries
        .filter(({ state }) => state === 'scheduled')
        .map(({ id }) => id),
    ),
  );
  const platform = await startPlatform({
    publicAddress: options.publicAddress,
    index,
    resolved,
    commandOf: stagedCommandOf(bundlesPath),
    hostPart: stagedHostPart(bundlesPath),
    diagnostics,
    required: options.required,
    composition: {
      overridesPath: compositionOverridesPath(options.compositionPath),
      read: () => readBootComposition(options.composition),
      resolve: async (generation) => {
        const next = await readHostResolution({ ...options, generation });

        if ('reason' in next) throw new Error(next.reason);

        return next;
      },
    },
    startup,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.exit === undefined ? {} : { exit: options.exit }),
    writeLog: ({ level, message, fields, traceId, ...origin }, call) => {
      bundlesLog[isLogLevel(level) ? level : 'info'](
        {
          bundleId: origin.bundleId,
          version: origin.version,
          generation: origin.generation,
          environment: origin.environment,
          scope: origin.scope,
          ...(traceId === undefined ? {} : { traceId }),
          caller: call.caller,
          ...(fields === undefined ? {} : { fields }),
        },
        message,
      );
    },
    beforeListen: async (doric) => {
      const [skills, tools] = await Promise.all([
        doric.client(SkillsService).list({}),
        doric.client(ToolsService).list({}),
      ]);

      startupLog.info(
        {
          bundleCount: diagnostics
            .snapshot()
            .bundles.filter(({ state }) => state === 'active').length,
          skillCount: skills.skills.length,
          toolCount: tools.tools.length,
        },
        'Bundles loaded',
      );
      await runHostHook(doric, 'onHostStartHook');
      // The platform binds the public listener right after this step, so a
      // bind failure is reported at `network_binding`.
      startup.stage('network_binding');
      startupLog.info(
        { address: options.publicAddress },
        'Binding HTTP listener',
      );
    },
    beforeStop: (doric, signal) =>
      runHostHook(doric, 'onHostStopHook', { signal }),
  });

  if (platform.structuralFault !== undefined) {
    const error = recovery(platform.structuralFault);

    await platform.shutdown();
    throw error;
  }

  return { platform, resolved, diagnostics };
};

/**
 * `onHostReadyHook` of `doric.app.hooks/v1`, run as `doric` after the public
 * listener listens and before `Doric listening`. Resolves once every handler
 * was called; a failure (no `hooks/v1` provider, a `Run` error) is logged at
 * `warn` with its code and never thrown.
 */
export const hostReady = async (
  platform: Platform,
  logger: Logger,
): Promise<void> => {
  try {
    await runHostHook(platform, 'onHostReadyHook');
  } catch (error) {
    logger.warn(
      {
        code:
          error instanceof Error && 'code' in error ? error.code : 'internal',
        reason: messageOf(error),
      },
      'onHostReadyHook failed',
    );
  }
};
