import { basicContractSpec } from '../contracts/basic/index.js';
import type { Cardinality } from '../contracts/define.js';
import type { Environment } from '../contracts/ids.js';
import type {
  Phase,
  QuarantineCode,
  QuarantineReason,
} from '../contracts/platform.js';
import type { Composition } from './composition.js';
import type { Descriptor, DescriptorEntry } from './descriptor.js';
import { type ManifestV1, parseContractEntry } from './manifest.js';
import { satisfies } from './semver.js';

export type CatalogSource =
  | { readonly kind: 'installed'; readonly dir: string }
  | { readonly kind: 'embedded' };

/** One bundle the resolver considers, with what reading it produced. */
export interface CatalogCandidate {
  /** Manifest ID, or the directory name when the manifest could not be read. */
  readonly id: string;
  readonly source: CatalogSource;
  readonly manifest?: ManifestV1;
  readonly descriptor?: Descriptor;
  /** Problems found while reading (invalid manifest or descriptor). */
  readonly errors: readonly QuarantineReason[];
}

export type EntryState = 'scheduled' | 'quarantined' | 'disabled';

export interface CatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly description?: string;
  readonly source: CatalogSource;
  readonly manifest?: ManifestV1;
  readonly descriptor?: Descriptor;
  readonly phase?: Phase;
  readonly state: EntryState;
  readonly reasons: readonly QuarantineReason[];
  /** Bundles in this environment whose activation this one waits for. */
  readonly dependencies: readonly string[];
}

export interface ResolvedProvider {
  readonly bundleId: string;
  /** Contract version declared in `provides`. */
  readonly version: string;
  readonly bundleVersion: string;
}

export interface ResolvedContract {
  readonly id: string;
  readonly environment: Environment;
  readonly cardinality: Cardinality;
  /** Active providers: at most one for `one`. */
  readonly providers: readonly ResolvedProvider[];
}

export interface ResolvedEnvironment {
  readonly environment: Environment;
  readonly generation: number;
  readonly composition: Composition;
  readonly issues: readonly string[];
  readonly entries: readonly CatalogEntry[];
  /** Activation order: foundation, core, others. */
  readonly order: readonly string[];
  readonly contracts: readonly ResolvedContract[];
  readonly recovery?: { readonly reason: string };
}

export interface ResolveInput {
  readonly candidates: readonly CatalogCandidate[];
  readonly composition: Composition;
  readonly platformVersion: string;
  readonly generation: number;
  /** Problems found before resolution (for example an unreadable composition). */
  readonly issues?: readonly string[];
  /** Forces recovery mode (for example when the composition is invalid). */
  readonly recovery?: { readonly reason: string };
}

const BACKENDS = new Set(['storage.backend/v1', 'secrets.backend/v1']);

/** Core facades whose replacement may require the backends (decision "Fundação"). */
const FACADES = new Set(['events/v1', 'settings/v1', 'models/v1']);

/** Environments whose providers satisfy a part in each environment. */
const reachable: Readonly<Record<Environment, readonly Environment[]>> = {
  host: ['host'],
  desktopMain: ['desktopMain'],
  client: ['client', 'desktopMain', 'host'],
};

/** The bundle that owns a contract: `git` for `git.commands/v1` and `git/v1`. */
const ownerOf = (contract: string): string =>
  contract.slice(0, contract.indexOf('/')).split('.')[0] ?? '';

const lexical = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

interface Working {
  readonly candidate: CatalogCandidate;
  readonly id: string;
  state: EntryState;
  phase?: Phase;
  readonly reasons: QuarantineReason[];
  dependencies: Set<string>;
  readonly duplicate: boolean;
}

const reason = (
  code: QuarantineCode,
  message: string,
  contract?: string,
): QuarantineReason =>
  contract === undefined ? { code, message } : { code, message, contract };

const consistencyProblem = (
  manifest: ManifestV1,
  descriptor: Descriptor,
): string | undefined => {
  if (
    descriptor.bundle.id !== manifest.id ||
    descriptor.bundle.version !== manifest.version
  ) {
    return `descriptor is for ${descriptor.bundle.id} ${descriptor.bundle.version}, manifest is ${manifest.id} ${manifest.version}`;
  }

  const provides = new Map<string, string>();

  for (const entry of manifest.provides) {
    const parsed = parseContractEntry(entry);

    if (parsed !== undefined) {
      provides.set(parsed.id, parsed.spec);
    }
  }

  const described = new Set<string>();

  for (const entry of descriptor.contracts) {
    const key = `${entry.id} ${entry.environment}`;

    if (described.has(key)) {
      return `descriptor lists ${entry.id} twice in ${entry.environment}`;
    }

    described.add(key);

    const version = provides.get(entry.id);

    if (version === undefined) {
      return `descriptor lists ${entry.id}, which provides does not declare`;
    }

    if (version !== entry.version) {
      return `descriptor lists ${entry.id}@${entry.version}, provides declares ${version}`;
    }
  }

  for (const id of provides.keys()) {
    if (!descriptor.contracts.some((entry) => entry.id === id)) {
      return `provides declares ${id}, which the descriptor does not list`;
    }
  }

  return undefined;
};

/**
 * Pure, deterministic resolution of one environment: catalog states,
 * foundation, active providers, per-environment requires, quarantine cascade,
 * activation order and recovery. Executes no bundle code.
 */
export const resolveEnvironment = (
  input: ResolveInput,
  environment: Environment,
): ResolvedEnvironment => {
  const { composition } = input;
  const issues = [...(input.issues ?? [])];
  const working: Working[] = [];
  const byId = new Map<string, Working>();

  const quarantine = (entry: Working, why: QuarantineReason) => {
    if (entry.state !== 'disabled') {
      entry.state = 'quarantined';
    }

    entry.reasons.push(why);
  };

  /** D-35: candidates without a manifest, by display label (first wins). */
  const unreadable = new Map<string, Working>();

  for (const candidate of input.candidates) {
    if (candidate.manifest === undefined) {
      // No known ID: the label is only for display and never collides with,
      // or counts as, a real bundle ID.
      const entry: Working = {
        candidate,
        id: candidate.id,
        state: 'quarantined',
        reasons:
          candidate.errors.length > 0
            ? [...candidate.errors]
            : [reason('invalid_manifest', 'manifest is missing')],
        dependencies: new Set(),
        duplicate: false,
      };

      working.push(entry);

      if (!unreadable.has(candidate.id)) {
        unreadable.set(candidate.id, entry);
      }

      continue;
    }

    const duplicate = byId.has(candidate.id);
    const entry: Working = {
      candidate,
      id: candidate.id,
      state: 'scheduled',
      reasons: [...candidate.errors],
      dependencies: new Set(),
      duplicate,
    };

    working.push(entry);

    if (duplicate) {
      quarantine(
        entry,
        reason(
          'duplicate_id',
          `bundle ID "${candidate.id}" is already used by another installed bundle`,
        ),
      );
      continue;
    }

    byId.set(candidate.id, entry);
  }

  const enabled = new Set(composition.enabled);

  for (const candidate of input.candidates) {
    if (candidate.source.kind === 'embedded') {
      enabled.add(candidate.id);
    }
  }

  for (const id of composition.enabled) {
    if (!byId.has(id) && !unreadable.has(id)) {
      issues.push(`missing bundle ${id}`);
    }
  }

  // Enablement, read errors, engines and descriptor consistency.
  for (const entry of working) {
    const { manifest, descriptor } = entry.candidate;

    if (entry.duplicate || manifest === undefined) {
      continue;
    }

    if (!enabled.has(entry.id)) {
      entry.state = 'disabled';
      continue;
    }

    if (entry.reasons.length > 0) {
      entry.state = 'quarantined';
      continue;
    }

    if (!satisfies(input.platformVersion, manifest.engines.doric)) {
      quarantine(
        entry,
        reason(
          'engines_unsatisfied',
          `requires doric ${manifest.engines.doric}; platform is ${input.platformVersion}`,
        ),
      );
      continue;
    }

    if (descriptor === undefined) {
      quarantine(
        entry,
        reason('invalid_descriptor', 'contracts.json is missing'),
      );
      continue;
    }

    const problem = consistencyProblem(manifest, descriptor);

    if (problem !== undefined) {
      quarantine(entry, reason('invalid_descriptor', problem));
    }
  }

  const live = (entry: Working | undefined): entry is Working =>
    entry !== undefined && entry.state === 'scheduled';
  const describedIn = (
    entry: Working,
    env: Environment,
  ): readonly DescriptorEntry[] =>
    entry.candidate.descriptor?.contracts.filter(
      (contract) => contract.environment === env,
    ) ?? [];
  const providesIn = (
    entry: Working,
    contract: string,
    env: Environment,
  ): DescriptorEntry | undefined =>
    describedIn(entry, env).find((described) => described.id === contract);
  const declaredBy = (
    entry: Working | undefined,
    contract: string,
    env: Environment,
  ): Cardinality | undefined =>
    entry === undefined
      ? undefined
      : providesIn(entry, contract, env)?.cardinality;
  const manifestProvides = (entry: Working, contract: string): boolean =>
    entry.candidate.manifest?.provides.some(
      (declared) => parseContractEntry(declared)?.id === contract,
    ) ?? false;
  const requiresOf = (entry: Working) =>
    (entry.candidate.manifest?.requires ?? []).flatMap((declared) => {
      const parsed = parseContractEntry(declared);

      return parsed === undefined ? [] : [parsed];
    });

  let recovery = input.recovery;
  const recover = (why: string) => {
    recovery ??= { reason: why };
  };
  const core = byId.get(composition.core);
  const coreId = composition.core;
  const reasonsText = (entry: Working) =>
    entry.reasons.map((item) => item.message).join('; ');

  if (core === undefined) {
    const label = unreadable.get(coreId);

    recover(
      `core ${coreId} unavailable: ${label === undefined ? 'not installed' : reasonsText(label)}`,
    );
  } else if (core.state === 'disabled') {
    recover(`core ${coreId} unavailable: not enabled`);
  } else if (core.state === 'quarantined') {
    recover(`core ${coreId} unavailable: ${reasonsText(core)}`);
  }

  // Provider choices.
  const choices = new Map<string, string>();

  for (const [contract, bundleId] of Object.entries(composition.providers)) {
    const chosen = byId.get(bundleId);

    if (chosen === undefined || !enabled.has(bundleId)) {
      issues.push(
        `provider choice ${contract} -> ${bundleId} ignored: bundle not enabled`,
      );
      continue;
    }

    if (!manifestProvides(chosen, contract)) {
      issues.push(
        `provider choice ${contract} -> ${bundleId} ignored: bundle does not provide it`,
      );
      continue;
    }

    choices.set(contract, bundleId);
  }

  const chosenIn = (
    contract: string,
    env: Environment,
  ): Working | undefined => {
    const bundleId = choices.get(contract);
    const chosen = bundleId === undefined ? undefined : byId.get(bundleId);

    if (chosen === undefined) {
      return undefined;
    }

    // Without a usable descriptor the environment is unknown: assume this one.
    return chosen.candidate.descriptor === undefined ||
      providesIn(chosen, contract, env) !== undefined
      ? chosen
      : undefined;
  };

  // Foundation: chosen providers of contracts core provides or requires here.
  const foundation = new Map<string, string[]>();
  const coreProvides = new Set(
    core === undefined
      ? []
      : describedIn(core, environment).map(({ id }) => id),
  );
  const coreRequires = new Set(
    core === undefined ? [] : requiresOf(core).map(({ id }) => id),
  );

  for (const contract of choices.keys()) {
    const chosen = chosenIn(contract, environment);

    if (
      chosen === undefined ||
      chosen.id === coreId ||
      !(coreProvides.has(contract) || coreRequires.has(contract))
    ) {
      continue;
    }

    foundation.set(chosen.id, [...(foundation.get(chosen.id) ?? []), contract]);
  }

  for (const [bundleId, contracts] of foundation) {
    const entry = byId.get(bundleId) as Working;

    entry.phase = 'foundation';

    if (!live(entry)) {
      continue;
    }

    const replacesFacade = contracts.some((contract) => FACADES.has(contract));

    for (const required of requiresOf(entry)) {
      if (!(BACKENDS.has(required.id) && replacesFacade)) {
        quarantine(
          entry,
          reason(
            'foundation_requires',
            `foundation bundle may not require ${required.id}`,
            required.id,
          ),
        );
        break;
      }
    }
  }

  // Providers per contract in this environment, with cardinality.
  const providersOf = (contract: string, env: Environment): Working[] =>
    working.filter(
      (entry) =>
        !entry.duplicate &&
        entry.state !== 'disabled' &&
        entry.candidate.manifest !== undefined &&
        providesIn(entry, contract, env) !== undefined,
    );
  const contractIds = new Set<string>();

  for (const entry of working) {
    if (live(entry)) {
      for (const described of describedIn(entry, environment)) {
        contractIds.add(described.id);
      }
    }
  }

  /**
   * The cardinality a contract is published with in an environment: the fixed
   * table for basic contracts; otherwise the descriptor of the bundle that owns
   * it (the bundle whose ID prefixes the contract ID), then the provider the
   * composition chose, then core, and only then the first live provider.
   */
  const expectedCardinality = (
    contract: string,
    env: Environment,
  ): Cardinality | undefined => {
    const basic = basicContractSpec(contract)?.cardinality;

    if (basic !== undefined) {
      return basic;
    }

    const providers = providersOf(contract, env);
    const owner = providers.find(({ id }) => id === ownerOf(contract));

    return (
      declaredBy(owner, contract, env) ??
      declaredBy(chosenIn(contract, env), contract, env) ??
      declaredBy(core, contract, env) ??
      declaredBy(providers.filter(live)[0], contract, env)
    );
  };
  const cardinalities = new Map<string, Cardinality>();

  for (const contract of [...contractIds].sort(lexical)) {
    const providers = providersOf(contract, environment).filter(live);
    const expected = expectedCardinality(contract, environment);

    if (expected === undefined) {
      continue;
    }

    cardinalities.set(contract, expected);

    for (const provider of providers) {
      const declared = providesIn(provider, contract, environment)?.cardinality;

      if (declared !== expected) {
        quarantine(
          provider,
          reason(
            'cardinality_mismatch',
            `declares ${contract} as ${declared}; the catalog publishes ${expected}`,
            contract,
          ),
        );
      }
    }
  }

  /** The active provider of a `one` contract in an environment, by current states. */
  const activeOf = (
    contract: string,
    env: Environment,
  ): Working | undefined => {
    if (choices.has(contract)) {
      const chosen = chosenIn(contract, env);

      if (chosen !== undefined) {
        return live(chosen) ? chosen : undefined;
      }
    }

    const candidates = providersOf(contract, env).filter(live);

    if (core !== undefined && live(core) && candidates.includes(core)) {
      return core;
    }

    return [...candidates].sort((left, right) => lexical(left.id, right.id))[0];
  };

  const cardinalityIn = (contract: string, env: Environment): Cardinality => {
    if (env === environment && cardinalities.has(contract)) {
      return cardinalities.get(contract) as Cardinality;
    }

    return (
      expectedCardinality(contract, env) ??
      declaredBy(providersOf(contract, env)[0], contract, env) ??
      'one'
    );
  };

  // Second providers of `one` contracts.
  for (const contract of [...contractIds].sort(lexical)) {
    if (cardinalities.get(contract) !== 'one') {
      continue;
    }

    const active = activeOf(contract, environment);

    for (const provider of providersOf(contract, environment).filter(live)) {
      if (provider === active || provider.id === coreId) {
        continue;
      }

      const activeText =
        active === undefined
          ? 'none'
          : `${active.id} ${providesIn(active, contract, environment)?.version}`;

      quarantine(
        provider,
        reason(
          'unchosen_provider',
          choices.has(contract)
            ? `provider of ${contract} not chosen in providers; active: ${activeText}`
            : `second provider of ${contract} without a choice in providers; active: ${activeText}`,
          contract,
        ),
      );
    }
  }

  // Requires per environment, iterated to a fixpoint so quarantine cascades.
  const checkRequires = (entry: Working): QuarantineReason | undefined => {
    const dependencies = new Set<string>();

    for (const required of requiresOf(entry)) {
      let constrained = false;

      for (const env of reachable[environment]) {
        if (providersOf(required.id, env).length === 0) {
          continue;
        }

        constrained = true;

        const providers =
          cardinalityIn(required.id, env) === 'many'
            ? providersOf(required.id, env).filter(live)
            : [activeOf(required.id, env)].filter(
                (provider): provider is Working => provider !== undefined,
              );

        if (providers.length === 0) {
          return reason(
            'dependency_quarantined',
            `requires ${required.id}@${required.spec}; its provider is quarantined`,
            required.id,
          );
        }

        for (const provider of providers) {
          const version = providesIn(provider, required.id, env)?.version ?? '';

          if (!satisfies(version, required.spec)) {
            return reason(
              'incompatible_version',
              `requires ${required.id}@${required.spec}; active ${version} (${provider.id} ${provider.candidate.manifest?.version})`,
              required.id,
            );
          }

          if (env === environment && provider !== entry) {
            dependencies.add(provider.id);
          }
        }

        break;
      }

      if (constrained) {
        continue;
      }

      const providedElsewhere = (
        ['host', 'desktopMain', 'client'] as const
      ).some((env) => providersOf(required.id, env).length > 0);

      if (!providedElsewhere) {
        return reason(
          'missing_dependency',
          `requires ${required.id}@${required.spec}; no enabled bundle provides it`,
          required.id,
        );
      }
    }

    entry.dependencies = dependencies;

    return undefined;
  };

  const cascade = () => {
    for (let changed = true; changed; ) {
      changed = false;

      for (const entry of working) {
        if (!live(entry) || entry.id === coreId) {
          continue;
        }

        const problem = checkRequires(entry);

        if (problem !== undefined) {
          quarantine(entry, problem);
          changed = true;
        }
      }
    }
  };

  cascade();

  // Core requires: only foundation contracts, with satisfied ranges.
  if (core !== undefined && live(core)) {
    for (const required of requiresOf(core)) {
      const providers = providersOf(required.id, environment);

      if (providers.length === 0) {
        const elsewhere = (['host', 'desktopMain', 'client'] as const).some(
          (env) => providersOf(required.id, env).length > 0,
        );

        if (!elsewhere) {
          recover(
            `core ${coreId} requires ${required.id}@${required.spec}; no enabled bundle provides it`,
          );
        }

        continue;
      }

      const active = activeOf(required.id, environment);

      if (active === undefined || !foundation.has(active.id)) {
        recover(
          `core ${coreId} requires ${required.id}@${required.spec}, which no active foundation bundle provides`,
        );
        continue;
      }

      const version =
        providesIn(active, required.id, environment)?.version ?? '';

      if (!satisfies(version, required.spec)) {
        recover(
          `core ${coreId} requires ${required.id}@${required.spec}; active ${version} (${active.id})`,
        );
      }
    }
  }

  const order: string[] = [];
  const topological = (members: readonly Working[]): Working[] => {
    const ids = new Set(members.map(({ id }) => id));
    const remaining = new Map(
      members.map((entry) => [
        entry.id,
        new Set([...entry.dependencies].filter((id) => ids.has(id))),
      ]),
    );
    const sorted: Working[] = [];

    for (;;) {
      const ready = [...remaining.entries()]
        .filter(([, dependencies]) => dependencies.size === 0)
        .map(([id]) => id)
        .sort(lexical);

      if (ready.length === 0) {
        break;
      }

      const next = ready[0] as string;

      remaining.delete(next);
      sorted.push(byId.get(next) as Working);

      for (const dependencies of remaining.values()) {
        dependencies.delete(next);
      }
    }

    // Whatever is left waits on a cycle; quarantine the members of the cycles.
    if (remaining.size > 0) {
      const reaches = (
        from: string,
        target: string,
        seen: Set<string>,
      ): boolean => {
        for (const next of remaining.get(from) ?? []) {
          if (next === target) {
            return true;
          }

          if (!seen.has(next)) {
            seen.add(next);

            if (reaches(next, target, seen)) {
              return true;
            }
          }
        }

        return false;
      };

      for (const id of [...remaining.keys()].sort(lexical)) {
        if (reaches(id, id, new Set())) {
          quarantine(
            byId.get(id) as Working,
            reason('dependency_cycle', 'is part of a requires cycle'),
          );
        }
      }
    }

    return sorted;
  };

  // Order, repeated while cycle quarantine cascades.
  for (;;) {
    const before = working.filter(live).length;
    const scheduled = working.filter(live);
    const foundationLive = scheduled.filter((entry) =>
      foundation.has(entry.id),
    );
    const backends = foundationLive.filter((entry) =>
      describedIn(entry, environment).some(({ id }) => BACKENDS.has(id)),
    );
    const restFoundation = foundationLive.filter(
      (entry) => !backends.includes(entry),
    );
    const others = scheduled.filter(
      (entry) => !foundation.has(entry.id) && entry.id !== coreId,
    );

    order.length = 0;

    const sorted = [
      ...topological(backends),
      ...topological(restFoundation),
      ...(core !== undefined && live(core) ? [core] : []),
      ...topological(others),
    ];

    if (working.filter(live).length === before) {
      order.push(...sorted.filter(live).map(({ id }) => id));
      break;
    }

    cascade();
  }

  // A quarantined chosen foundation provider never falls back to core.
  for (const [bundleId, contracts] of foundation) {
    const entry = byId.get(bundleId) as Working;

    if (entry.state === 'quarantined') {
      recover(
        `chosen provider ${bundleId} of ${contracts.join(', ')} is quarantined: ${reasonsText(entry)}`,
      );
    }
  }

  for (const entry of working) {
    if (entry.phase === undefined && live(entry)) {
      entry.phase = entry.id === coreId ? 'core' : 'others';
    }
  }

  const contracts: ResolvedContract[] = [...contractIds]
    .sort(lexical)
    .map((contract) => {
      const cardinality = cardinalities.get(contract) ?? 'one';
      const active =
        cardinality === 'many'
          ? providersOf(contract, environment).filter(live)
          : [activeOf(contract, environment)].filter(
              (provider): provider is Working => provider !== undefined,
            );

      return {
        id: contract,
        environment,
        cardinality,
        providers: active.map((provider) => ({
          bundleId: provider.id,
          version: providesIn(provider, contract, environment)?.version ?? '',
          bundleVersion: provider.candidate.manifest?.version ?? '',
        })),
      };
    });

  const entries: CatalogEntry[] = working.map((entry) => {
    const { manifest, descriptor, source } = entry.candidate;

    return {
      id: entry.id,
      version: manifest?.version ?? '0.0.0',
      ...(manifest?.description === undefined
        ? {}
        : { description: manifest.description }),
      source,
      ...(manifest === undefined ? {} : { manifest }),
      ...(descriptor === undefined ? {} : { descriptor }),
      ...(entry.phase === undefined ? {} : { phase: entry.phase }),
      state: entry.state,
      reasons: [...entry.reasons],
      dependencies: [...entry.dependencies].sort(lexical),
    };
  });

  return {
    environment,
    generation: input.generation,
    composition,
    issues,
    entries,
    order,
    contracts,
    ...(recovery === undefined ? {} : { recovery }),
  };
};
