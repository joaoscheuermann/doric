import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SkillsV1 } from '../contracts/basic/skills.js';
import {
  StorageBackendV1,
  type StorageIdentity,
} from '../contracts/basic/storage.js';
import { ToolsV1 } from '../contracts/basic/tools.js';
import type { Call, CallScope } from '../contracts/call.js';
import type { Activate, Services } from '../contracts/context.js';
import type {
  CatalogSnapshot,
  Diagnostics,
  QuarantineCode,
} from '../contracts/platform.js';
import { isRegistrable } from '../contracts/registrable.js';
import {
  ActivationFailure,
  type ActivationResult,
  activateEnvironment,
  catalogView,
  type PlatformLog,
} from '../runtime/activation.js';
import { createHopCall } from '../runtime/call.js';
import type { CatalogEntry, ResolvedEnvironment } from '../runtime/catalog.js';
import { type Composition, compositionSchema } from '../runtime/composition.js';
import { DiagnosticsStore } from '../runtime/diagnostics.js';
import { ServiceDirectory } from '../runtime/directory.js';
import type { LegacyResource } from '../runtime/manifest.js';
import type { Principal, ServiceRuntime } from '../runtime/principal.js';
import { createPrincipal } from '../runtime/services.js';
import { PLATFORM_VERSION } from '../runtime/version.js';
import { buildCatalog, type EmbeddedBundle, embeddedId } from './catalog.js';
import { discoverBundles, type InstalledBundle } from './discover.js';
import type { LogSink } from './log.js';
import { catalogSnapshot, providePlatformServices } from './platform.js';
import { readComposition } from './read.js';
import {
  discoverSkills,
  type ParsedSkill,
  readSkill,
  resourcePath,
} from './skills.js';

export interface StartHostOptions {
  /** Root whose immediate subdirectories are installed bundles. */
  readonly bundlesPath: string;
  readonly composition: Composition | { readonly path: string };
  readonly embedded?: readonly EmbeddedBundle[];
  /** The platform's own log. */
  readonly log: PlatformLog;
  /** Where `doric.log/v1` records are written. */
  readonly sink: LogSink;
  readonly now?: () => number;
}

export interface PlatformCallOptions {
  readonly scope?: CallScope;
  readonly signal?: AbortSignal;
  readonly deadline?: number;
}

export interface HostPlatform {
  readonly mode: 'normal' | 'recovery';
  readonly generation: number;
  /** Principal `doric`: may use any contract. */
  readonly services: Services;
  /** A platform-originated Call (caller doric, new trace). */
  call(options?: PlatformCallOptions): Call;
  catalog(): CatalogSnapshot;
  /**
   * The storage identity of the active storage.backend/v1 provider, or
   * undefined without one. A resolved identity is kept (and published in the
   * catalog); a failure is not, so the next call asks the backend again.
   */
  storageIdentity(): Promise<StorageIdentity | undefined>;
  diagnostics(): Diagnostics;
  /** Fires AppHooksV1.onHostReadyHook once; no-op in recovery mode. */
  ready(): Promise<void>;
  /** Reverse deactivation; idempotent. */
  stop(): Promise<void>;
}

/** Generations are counted per process, one per published catalog. */
let generations = 0;

const messageOf = (error: unknown): string => {
  const parts: string[] = [];

  for (
    let current: unknown = error;
    current instanceof Error;
    current = current.cause
  ) {
    parts.push(current.message);
  }

  return parts.length > 0 ? parts.join(': ') : String(error);
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
};

const isToolDefinition = (value: unknown): boolean =>
  isRegistrable(value) &&
  typeof (value as { name?: unknown }).name === 'string' &&
  typeof (value as { definition?: unknown }).definition === 'object' &&
  (value as { definition?: unknown }).definition !== null;

const failure = (code: QuarantineCode, error: unknown): ActivationFailure =>
  new ActivationFailure(code, messageOf(error), { cause: error });

/** Imports `<dir>/host/index.js` and returns its `activate`. */
const importHostPart = async (dir: string): Promise<Activate | undefined> => {
  const path = join(dir, 'host', 'index.js');

  if (!(await fileExists(path))) {
    return undefined;
  }

  const loaded = (await import(pathToFileURL(path).href)) as {
    readonly activate?: unknown;
  };

  if (typeof loaded.activate !== 'function') {
    throw new ActivationFailure(
      'invalid_part',
      `host/index.js of "${dir}" does not export an activate function.`,
    );
  }

  return loaded.activate as Activate;
};

/** v0 only: registers manifest-listed tools on the bundle's behalf. */
const registerLegacyTools = async (
  dir: string,
  tools: readonly LegacyResource[],
  principal: Principal,
): Promise<void> => {
  if (tools.length === 0) {
    return;
  }

  const registry = principal.unchecked.use(ToolsV1);

  for (const declared of tools) {
    let definition: unknown;

    try {
      const loaded = (await import(
        pathToFileURL(resourcePath(dir, declared.path)).href
      )) as { readonly default?: unknown };

      definition = loaded.default;
    } catch (error) {
      throw failure('invalid_part', error);
    }

    if (typeof definition === 'function' || !isToolDefinition(definition)) {
      throw new ActivationFailure(
        'invalid_part',
        typeof definition === 'function'
          ? `"${declared.path}" exports a legacy tool factory; v0 tools must default-export a tool definition.`
          : `"${declared.path}" does not default-export a tool definition.`,
      );
    }

    try {
      registry.register(definition as Parameters<typeof registry.register>[0], {
        alwaysAvailable: declared.alwaysAvailable,
      });
    } catch (error) {
      throw failure('registration_failed', error);
    }
  }
};

/** Registers skills through skills/v1, with the bundle as caller. */
const registerSkills = async (
  dir: string,
  skills: readonly {
    readonly path: string;
    readonly alwaysAvailable?: boolean;
  }[],
  frontmatterAvailability: boolean,
  principal: Principal,
): Promise<void> => {
  if (skills.length === 0) {
    return;
  }

  if (principal.runtime.directory.active(SkillsV1.id) === undefined) {
    throw new ActivationFailure(
      'missing_dependency',
      `bundle has skills but no skills/v1 provider is active`,
    );
  }

  const registry = principal.unchecked.use(SkillsV1);

  for (const declared of skills) {
    let parsed: ParsedSkill;

    try {
      parsed = await readSkill(dir, declared.path, { frontmatterAvailability });
    } catch (error) {
      throw failure('skill_invalid', error);
    }

    const alwaysAvailable =
      declared.alwaysAvailable ?? parsed.alwaysAvailable ?? false;

    try {
      registry.register(parsed.skill, { alwaysAvailable });
    } catch (error) {
      throw failure('registration_failed', error);
    }
  }
};

const placeholderComposition: Composition = Object.freeze({
  core: '',
  enabled: [],
  providers: {},
}) as Composition;

/**
 * Boots the host environment: discovers installed bundles, reads the
 * composition, resolves the catalog, registers the platform providers and
 * activates foundation, core and the others.
 */
export const startHost = async (
  options: StartHostOptions,
): Promise<HostPlatform> => {
  generations += 1;

  const generation = generations;
  const controller = new AbortController();
  const issues: string[] = [];
  let recovery: { readonly reason: string } | undefined;
  let installed: readonly InstalledBundle[] = [];

  try {
    installed = await discoverBundles(options.bundlesPath);
  } catch (error) {
    issues.push(messageOf(error));
  }

  let composition = placeholderComposition;

  try {
    composition =
      'path' in options.composition
        ? await readComposition(options.composition.path)
        : compositionSchema.parse(options.composition);
  } catch (error) {
    recovery = { reason: `invalid composition: ${messageOf(error)}` };
  }

  const embedded = options.embedded ?? [];
  const resolved: ResolvedEnvironment = buildCatalog({
    installed,
    embedded,
    composition,
    platformVersion: PLATFORM_VERSION,
    generation,
    issues,
    ...(recovery === undefined ? {} : { recovery }),
  });
  const diagnostics = new DiagnosticsStore({
    generation,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  diagnostics.load(resolved);

  for (const entry of resolved.entries) {
    if (entry.state === 'quarantined') {
      options.log.warn(
        { bundleId: entry.id, reasons: entry.reasons },
        'Bundle quarantined',
      );
    }
  }

  const runtime: ServiceRuntime = {
    directory: new ServiceDirectory(),
    catalog: catalogView(resolved),
    environment: 'host',
    generation,
    generationSignal: controller.signal,
    report: (entry) => diagnostics.report(entry),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  const platform = createPrincipal(runtime, {
    bundleId: 'doric',
    version: PLATFORM_VERSION,
    provides: 'any',
    requires: 'any',
  });
  let storage: StorageIdentity | undefined;
  const snapshot = () => catalogSnapshot(resolved, diagnostics, storage);

  providePlatformServices(platform, {
    snapshot,
    diagnostics,
    sink: options.sink,
  });

  const installedById = new Map<string, InstalledBundle>();

  for (const bundle of installed) {
    const id = bundle.read?.manifest.id;

    if (id !== undefined && !installedById.has(id)) {
      installedById.set(id, bundle);
    }
  }

  const embeddedById = new Map(
    embedded.map((bundle) => [embeddedId(bundle), bundle]),
  );
  const loadPart = async (entry: CatalogEntry) => {
    if (entry.source.kind === 'embedded') {
      return embeddedById.get(entry.id)?.host?.activate as Activate | undefined;
    }

    return await importHostPart(entry.source.dir);
  };
  const afterActivate = async (entry: CatalogEntry, principal: Principal) => {
    if (entry.source.kind !== 'installed') {
      return;
    }

    const { dir } = entry.source;
    const legacy = installedById.get(entry.id)?.read?.legacy;

    if (legacy !== undefined) {
      await registerLegacyTools(dir, legacy.tools, principal);
      await registerSkills(dir, legacy.skills, false, principal);

      return;
    }

    const paths = await discoverSkills(dir);

    await registerSkills(
      dir,
      paths.map((path) => ({ path })),
      true,
      principal,
    );
  };
  const activation: ActivationResult = await activateEnvironment({
    resolved,
    runtime,
    platform,
    diagnostics,
    loadPart,
    afterActivate,
    log: options.log,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const final = diagnostics.snapshot();

  if (final.mode === 'recovery') {
    options.log.error(
      {
        reason: final.recovery?.reason,
        bundles: final.bundles.map(({ id, state, reasons }) => ({
          id,
          state,
          reasons,
        })),
      },
      'Bundle recovery mode',
    );
  }

  let readied: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let identity: Promise<StorageIdentity> | undefined;

  return {
    mode: final.mode,
    generation,
    services: platform.services,
    call: (callOptions = {}) =>
      createHopCall({
        caller: platform.caller,
        ...(callOptions.scope === undefined
          ? {}
          : { useScope: callOptions.scope }),
        arg: {
          ...(callOptions.signal === undefined
            ? {}
            : { signal: callOptions.signal }),
          ...(callOptions.deadline === undefined
            ? {}
            : { deadline: callOptions.deadline }),
        },
        generationSignal: controller.signal,
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
    catalog: snapshot,
    storageIdentity: async () => {
      if (
        identity === undefined &&
        runtime.directory.active(StorageBackendV1.id) === undefined
      ) {
        return undefined;
      }

      identity ??= platform.services
        .use(StorageBackendV1)
        .identity()
        .then((resolvedIdentity) => {
          storage = resolvedIdentity;

          return resolvedIdentity;
        });

      const pending = identity;

      try {
        return await pending;
      } catch (error) {
        if (identity === pending) {
          identity = undefined;
        }

        throw error;
      }
    },
    diagnostics: () => diagnostics.snapshot(),
    ready: () => {
      readied ??= (async () => {
        const appHooks = activation.appHooks();

        if (diagnostics.mode === 'recovery' || appHooks === undefined) {
          return;
        }

        try {
          await appHooks.onHostReadyHook.execute({});
        } catch (error) {
          diagnostics.report({
            bundleId: platform.bundleId,
            kind: 'hook_execute_failed',
            message: messageOf(error),
            details: { hook: 'onHostReadyHook' },
          });
        }
      })();

      return readied;
    },
    stop: () => {
      stopping ??= (async () => {
        await activation.stop();
        await platform.scope.dispose();
        platform.close();
        controller.abort();
      })();

      return stopping;
    },
  };
};
