import type { CatalogResult, CredentialKind, Models } from 'bundle/contracts';
import { readModelProperties } from 'core/contracts';
import type { BoundTool } from 'tool';

import type { ConfigReplaceResult } from '../../contracts/index.js';
import type { CredentialService } from '../credentials/service.js';
import {
  type ConfigInput,
  ConfigInputSchema,
  type DoricConfig,
  providerCredentials,
} from './schema.js';
import type { ConfigStore } from './store.js';
import { requireToolConfigs } from './tool-config.js';

/**
 * A configuration whose credential references are not usable. It is caller
 * input, not a host failure, so the route answers it as an invalid config.
 */
export class ConfigCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigCredentialError';
  }
}

/**
 * A configuration a bundled tool cannot read: a value its declared fields make
 * mandatory is missing. Like a credential fault this is caller input, so the
 * route answers it as an invalid config rather than a host failure.
 */
export class ConfigToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigToolError';
  }
}

/** What `host-config/v1` answers: the active snapshot and the PUT /config pipeline. */
export interface ConfigService {
  /** The active configuration, loaded from the store on first use. */
  current(): Promise<DoricConfig>;
  /** The PUT /config pipeline, serialized, over the request body as received. */
  replace(input: unknown): Promise<ConfigReplaceResult>;
}

export interface ConfigServiceOptions {
  readonly store: ConfigStore;
  /** The loaded credential service (`credential_activation`). */
  readonly credentials: () => Promise<CredentialService>;
  /** The tools of the active bundle generation (`tools/v1.list`). */
  readonly tools: () => readonly BoundTool[];
  /** `models/v1`: catalog reads and the provider builds of a configuration. */
  readonly models: Pick<Models, 'catalog' | 'prepare'>;
}

const invalidMessage = 'The Doric configuration is invalid.';

/** One serialized lane: a rejected operation does not block the next one. */
const serialQueue = () => {
  let tail: Promise<unknown> = Promise.resolve();

  return <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const run = tail.then(operation, operation);

    tail = run.catch(() => undefined);

    return run;
  };
};

/**
 * The configuration owner's service (design 57 §2.9, X-6). It answers the
 * stored snapshot and runs every replacement in request order: the
 * credential rule, the catalog fill (`models/v1.catalog`), the tool-field
 * rule, the candidate providers (`models/v1.prepare`), the store write, and
 * the activation of the stored revision's providers. Any failure after the
 * caller-input rules keeps the active configuration and answers `rejected`.
 */
export const createConfigService = ({
  store,
  credentials,
  tools,
  models,
}: ConfigServiceOptions): ConfigService => {
  let active: DoricConfig | undefined;
  let loading: Promise<DoricConfig> | undefined;
  const mutations = serialQueue();

  const load = (): Promise<DoricConfig> => {
    if (active !== undefined) return Promise.resolve(active);

    loading ??= store.load().then(
      (snapshot) => {
        active ??= snapshot;

        return active;
      },
      (error: unknown) => {
        loading = undefined;
        throw error;
      },
    );

    return loading;
  };

  const readCatalog = (provider: {
    readonly kind: string;
    readonly configuration: Readonly<Record<string, string>>;
  }): Promise<CatalogResult> =>
    models.catalog({
      kind: provider.kind,
      configuration: { ...provider.configuration },
    });

  return {
    current: load,
    replace: (input) => {
      const parsed = ConfigInputSchema.safeParse(input);

      if (!parsed.success)
        return Promise.resolve({ status: 'invalid', message: invalidMessage });

      // One lane serializes every replacement in request order.
      return mutations(async (): Promise<ConfigReplaceResult> => {
        try {
          const config = parsed.data;

          await load();
          requireCredentials(config, await credentials());
          const filled = await readModelProperties(config, readCatalog);

          try {
            requireToolConfigs(filled, tools());
          } catch (error) {
            throw new ConfigToolError(
              error instanceof Error
                ? error.message
                : 'A tool configuration is invalid.',
            );
          }

          // The candidate providers are built before anything is stored, so
          // a configuration that cannot be activated is never stored.
          await models.prepare({ ...filled });
          const snapshot = await store.replace(filled);

          await models.prepare({ ...snapshot });
          active = snapshot;

          return { status: 'replaced', config: snapshot };
        } catch (error) {
          if (
            error instanceof ConfigCredentialError ||
            error instanceof ConfigToolError
          )
            return { status: 'invalid', message: error.message };

          return { status: 'rejected' };
        }
      });
    },
  };
};

/**
 * Every `secret` field a provider carries names an `API_TOKEN` credential, the
 * Git identity is the `GIT` kind's alone, and the GitHub integration needs
 * another `API_TOKEN`. A reference is rejected before it is activated, so no
 * stored configuration can point at a credential of the wrong kind.
 */
const requireCredentials = (
  configuration: ConfigInput,
  credentials: CredentialService,
): void => {
  for (const provider of configuration.providers)
    for (const { field, id } of providerCredentials(provider))
      requireKind(
        credentials,
        id,
        'API_TOKEN',
        `Provider ${provider.id} ${field.key}`,
      );

  requireKind(
    credentials,
    configuration.gitCredentialId,
    'GIT',
    'The Git identity',
  );
  requireKind(
    credentials,
    configuration.githubCredentialId,
    'API_TOKEN',
    'The GitHub credential',
  );
};

const requireKind = (
  credentials: CredentialService,
  id: string | undefined,
  kind: CredentialKind,
  label: string,
): void => {
  if (id === undefined) return;

  const credential = credentials.find(id);
  if (credential === undefined)
    throw new ConfigCredentialError(
      `${label} references a credential that is not stored.`,
    );

  if (credential.kind !== kind)
    throw new ConfigCredentialError(
      `${label} must reference a ${kind} credential, not a ${credential.kind} one.`,
    );
};
