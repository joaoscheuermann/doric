import type { Logger } from 'pino';

import type { Bundle, Skill } from 'bundle';
import {
  createFetchTransport,
  createProviderForKind,
  type LlmProvider,
  type SecretSource,
} from 'llms';
import type { ToolFactory } from 'tool';

import type { CredentialService } from '../credentials/service.js';
import { type DoricConfig, providerCredentials } from './schema.js';

export type Catalog = {
  readonly skills: readonly Skill[];
  readonly tools: readonly ToolFactory[];
};

export type Generation = {
  readonly snapshot: DoricConfig;
  readonly providers: ReadonlyMap<string, LlmProvider>;
  readonly redactions: () => readonly string[];
  /**
   * Registers a secret the host learned after this generation was built — a
   * rotated credential it wrote into a running sandbox — so it is redacted
   * exactly like the ones the credential store already holds. A Project whose
   * generation predates a rotation would otherwise persist the new token
   * unredacted.
   */
  readonly registerSecret: (value: string) => void;
  readonly catalog: Catalog;
};

type GenerationOptions = {
  readonly snapshot: DoricConfig;
  readonly credentials: CredentialService;
  readonly bundles: readonly Bundle[];
  readonly logger: Logger;
};

/**
 * Builds one provider and bundle generation captured by new Projects. Each
 * provider is built from the kind it names and that kind's own values, and a
 * `secret` value is passed as a source rather than a value, so the key is read
 * from the credential store on every call and a rotation reaches a Project that
 * is already running.
 */
export const createGeneration = async ({
  snapshot,
  credentials,
  bundles,
  logger,
}: GenerationOptions): Promise<Generation> => {
  const registered = new Set<string>();

  const providers = new Map(
    snapshot.configuration.providers.map((provider) => [
      provider.id,
      createProviderForKind(
        provider.kind,
        providerValues(provider, credentials),
        {
          transport: createFetchTransport(),
          logger,
        },
      ),
    ]),
  );

  return {
    snapshot,
    providers,
    // Every stored secret is redacted, so no persisted history, event, tool
    // result, or log line can carry one, and a rotation is covered the moment
    // the store holds it.
    redactions: () => [...credentials.secrets(), ...registered],
    registerSecret: (value) => {
      if (value.length > 0) registered.add(value);
    },
    catalog: {
      skills: bundles.flatMap(({ skills }) => skills.map(({ skill }) => skill)),
      tools: bundles.flatMap(({ tools }) =>
        tools.map(({ factory }) => factory),
      ),
    },
  };
};

export const providerFor = (
  generation: Generation,
  id: string,
): LlmProvider => {
  const provider = generation.providers.get(id);

  if (provider === undefined) {
    throw new Error('Configured provider is unavailable.');
  }

  return provider;
};

/**
 * The values one configured provider carries, with each `secret` field passed as
 * the credential it names read at call time. A credential the store cannot read
 * yet contributes an empty value, which every kind reads as "no secret", exactly
 * like the empty secrets the credential migration seeds.
 */
const providerValues = (
  provider: DoricConfig['configuration']['providers'][number],
  credentials: CredentialService,
): Readonly<Record<string, SecretSource>> => {
  const values: Record<string, SecretSource> = {
    ...provider.configuration,
  };

  for (const { field, id } of providerCredentials(provider))
    values[field.key] = () => credentials.find(id)?.secret ?? '';

  return values;
};
