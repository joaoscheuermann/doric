import type { LanguageModel, ModelsProvider } from 'bundle/contracts';

import type { KindRegistry } from './registry.js';

/** One configured provider, as the Doric configuration carries it. */
export interface ConfiguredProvider {
  readonly id: string;
  readonly kind: string;
  /** The kind's own values; a `secret` field's value is a credential id. */
  readonly configuration: Readonly<Record<string, string>>;
}

interface Built {
  readonly api: ModelsProvider;
  readonly model: LanguageModel;
}

/** The providers of one configuration, built from its provider list. */
interface ProviderSet {
  /** The provider list it was built from, as JSON. */
  readonly key: string;
  readonly providers: readonly ConfiguredProvider[];
  readonly built: Map<string, Built>;
}

/** Reads one stored credential's secret at call time. */
export type SecretReader = (id: string) => Promise<string>;

export interface ProviderCache {
  /**
   * Builds every provider of a configuration, in order. A stored snapshot
   * (`revision` present) becomes the active set; a configuration without one is
   * a candidate that the next stored snapshot with the same providers adopts,
   * so the providers a replacement built are the ones it activates.
   */
  prepare(
    providers: readonly ConfiguredProvider[],
    revision: number | undefined,
  ): Promise<void>;
  /** The active set's provider, built again if its record was replaced. */
  resolve(providerId: string): Promise<LanguageModel>;
  /** Drops every provider a removed record built. */
  forget(api: ModelsProvider): void;
}

const unavailable = (): Error =>
  new Error('Configured provider is unavailable.');

/**
 * The provider cache of `models/v1`. Each configuration revision has its own
 * set of providers: a new revision builds new ones, and a running prompt keeps
 * the instance it resolved, as a running prompt kept the generation it
 * captured. A `secret` field is passed as a source read at request time, so a
 * credential rotation reaches providers that are already built.
 */
export const createProviderCache = (
  registry: KindRegistry,
  secretOf: SecretReader,
): ProviderCache => {
  let active: (ProviderSet & { readonly revision: number }) | undefined;
  let candidate: ProviderSet | undefined;

  const build = async (provider: ConfiguredProvider): Promise<Built> => {
    const entry = await registry.find(provider.kind);

    if (entry === undefined) {
      throw new Error(`Unknown provider kind: ${provider.kind}`);
    }

    const secretFields = new Set(
      entry.kind.fields
        .filter((field) => field.kind === 'secret')
        .map(({ key }) => key),
    );
    const values = Object.fromEntries(
      Object.entries(provider.configuration).filter(
        ([key]) => !secretFields.has(key),
      ),
    );
    // The first secret field the provider names is its credential; a field it
    // leaves out passes no source, as the host always built providers.
    const credential = entry.kind.fields
      .filter((field) => field.kind === 'secret')
      .map(({ key }) => provider.configuration[key])
      .find((id): id is string => id !== undefined);
    const model = await entry.api.create({
      providerId: provider.id,
      values,
      ...(credential === undefined
        ? {}
        : { secret: () => secretOf(credential) }),
    });

    return { api: entry.api, model };
  };

  const buildSet = async (
    providers: readonly ConfiguredProvider[],
  ): Promise<ProviderSet> => {
    const built = new Map<string, Built>();

    // One at a time, in configuration order, as the host built them.
    for (const provider of providers) {
      built.set(provider.id, await build(provider));
    }

    return { key: JSON.stringify(providers), providers, built };
  };

  return {
    prepare: async (providers, revision) => {
      const key = JSON.stringify(providers);

      if (revision === undefined) {
        candidate = await buildSet(providers);

        return;
      }

      if (active?.revision === revision && active.key === key) {
        return;
      }

      const set =
        candidate?.key === key ? candidate : await buildSet(providers);

      candidate = undefined;
      active = { ...set, revision };
    },
    resolve: async (providerId) => {
      const set = active;
      const built = set?.built.get(providerId);

      if (set === undefined) {
        throw unavailable();
      }

      if (built !== undefined) {
        return built.model;
      }

      const provider = set.providers.find(({ id }) => id === providerId);

      if (provider === undefined) {
        throw unavailable();
      }

      // Its record was replaced (a new generation): built again, lazily.
      const rebuilt = await build(provider).catch(() => {
        throw unavailable();
      });

      if (active === set) {
        set.built.set(providerId, rebuilt);
      }

      return rebuilt.model;
    },
    forget: (api) => {
      for (const set of [active, candidate]) {
        for (const [id, built] of set?.built ?? []) {
          if (built.api === api) {
            set?.built.delete(id);
          }
        }
      }
    },
  };
};
