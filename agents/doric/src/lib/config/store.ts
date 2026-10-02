import { randomUUID } from 'node:crypto';

import { type ProviderField, providerKind, type ProviderKindId } from 'llms';

import { ModelRole, type Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../database.js';
import {
  type ConfigInput,
  ConfigInputSchema,
  type DoricConfig,
} from './schema.js';

const singletonId = 1;

type StoredConfig = Prisma.DoricConfigurationGetPayload<{
  include: { providers: true; models: true };
}>;

type StoredProviderRow = StoredConfig['providers'][number];

/**
 * One model a stored provider lists, with the efforts it carries when its kind
 * keeps them. The stored JSON is read as this shape and handed to the schema,
 * which is what decides whether it matches the provider's kind.
 */
interface ProviderModelInput {
  readonly name: string;
  readonly reasonings?: readonly string[];
}

/**
 * One provider row read back as the configuration's own input, which the schema
 * then judges: a stored value that disagrees with its kind fails there rather
 * than being served as a valid configuration.
 */
interface ProviderInput {
  readonly id: string;
  readonly kind: ProviderKindId;
  readonly configuration: Readonly<Record<string, string>>;
  readonly models?: readonly ProviderModelInput[];
}

export type ConfigStore = {
  load(): Promise<DoricConfig>;
  replace(config: ConfigInput): Promise<DoricConfig>;
};

/**
 * The one value a kind carries that has to be a real column: a `secret` field is
 * a credential reference, which PostgreSQL can keep but JSON cannot. Every kind
 * declares at most one, so one column holds every provider's reference.
 */
const secretField = (kindId: string): ProviderField | undefined =>
  providerKind(kindId)?.fields.find((field) => field.kind === 'secret');

/** Persists the singleton configuration and its normalized provider/model rows. */
export const createConfigStore = (database: Database): ConfigStore => ({
  async load() {
    const stored = await database.doricConfiguration.findUniqueOrThrow({
      where: { id: singletonId },
      include: { providers: true, models: true },
    });
    return fromStored(stored);
  },

  async replace(config) {
    return database.$transaction(
      async (transaction) => {
        await transaction.modelConfiguration.deleteMany({
          where: { configurationId: singletonId },
        });
        await transaction.providerConfiguration.deleteMany({
          where: { configurationId: singletonId },
        });
        await transaction.providerConfiguration.createMany({
          data: config.providers.map((provider) => ({
            configurationId: singletonId,
            ...providerRow(provider),
          })),
        });
        await transaction.modelConfiguration.createMany({
          data: [
            {
              configurationId: singletonId,
              role: ModelRole.EXECUTION,
              providerId: config.models.execution.providerId,
              model: config.models.execution.model,
              effort: config.models.execution.effort ?? null,
            },
          ],
        });
        const stored = await transaction.doricConfiguration.update({
          where: { id: singletonId },
          data: {
            revision: { increment: 1 },
            generation: randomUUID(),
            maxTurns: config.execution.maxTurns,
            toolConfig: config.tools ?? {},
            gitCredentialId: config.gitCredentialId ?? null,
            githubCredentialId: config.githubCredentialId ?? null,
          },
          include: { providers: true, models: true },
        });
        return fromStored(stored);
      },
      { isolationLevel: 'Serializable' },
    );
  },
});

const fromStored = (stored: StoredConfig): DoricConfig => {
  const execution = stored.models.find(
    ({ role }) => role === ModelRole.EXECUTION,
  );
  if (execution === undefined)
    throw new Error(
      `Stored Doric model role is missing: ${ModelRole.EXECUTION}`,
    );

  const configuration = ConfigInputSchema.parse({
    providers: stored.providers
      .map(providerFromStored)
      .sort((left, right) => left.id.localeCompare(right.id)),
    models: {
      execution: {
        providerId: execution.providerId,
        model: execution.model,
        ...(execution.effort === null ? {} : { effort: execution.effort }),
      },
    },
    execution: { maxTurns: stored.maxTurns },
    tools: stored.toolConfig as Readonly<Record<string, Readonly<Record<string, string>>>>,
    ...(stored.gitCredentialId === null
      ? {}
      : { gitCredentialId: stored.gitCredentialId }),
    ...(stored.githubCredentialId === null
      ? {}
      : { githubCredentialId: stored.githubCredentialId }),
  });

  return {
    configuration,
    revision: stored.revision,
    updatedAt: stored.updatedAt.toISOString(),
  };
};

/**
 * One provider row as the configuration shape. The stored kind decides where the
 * credential comes from, and a model list a kind keeps is read even when the row
 * holds nothing, so a migrated provider round-trips as the kind it was mapped to.
 * A model list a kind does not keep is read only when the row disagrees with its
 * kind, which the configuration schema then rejects instead of dropping it
 * silently.
 */
const providerFromStored = (stored: StoredProviderRow): ProviderInput => {
  const kind = providerKind(stored.kind);
  if (kind === undefined)
    throw new Error(`Stored provider kind is unknown: ${stored.kind}`);

  const secret = secretField(stored.kind);
  const models = Array.isArray(stored.models)
    ? (stored.models as unknown as readonly ProviderModelInput[])
    : undefined;

  return {
    id: stored.id,
    kind: kind.id,
    configuration: {
      ...(stored.fieldValues as Readonly<Record<string, string>>),
      ...(secret === undefined || stored.credentialId === null
        ? {}
        : { [secret.key]: stored.credentialId }),
    },
    ...(models !== undefined &&
    (models.length > 0 || kind.lists.includes('models'))
      ? { models }
      : {}),
  };
};

/** One provider as its row: its field values, its credential, and its models. */
const providerRow = (provider: ConfigInput['providers'][number]) => {
  const secret = secretField(provider.kind);

  return {
    id: provider.id,
    kind: provider.kind,
    fieldValues: Object.fromEntries(
      Object.entries(provider.configuration).filter(
        ([key]) => key !== secret?.key,
      ),
    ),
    credentialId:
      secret === undefined
        ? null
        : (provider.configuration[secret.key] ?? null),
    models: provider.models ?? [],
  };
};
