import { randomUUID } from 'node:crypto';

import { ModelRole, type Prisma } from '../../generated/prisma/client.js';
import {
  ConfigInputSchema,
  type ConfigInput,
  type DoricConfig,
} from './schema.js';
import type { Database } from '../database.js';

const singletonId = 1;

type StoredConfig = Prisma.DoricConfigurationGetPayload<{
  include: { providers: true; models: true };
}>;

export type ConfigStore = {
  load(): Promise<DoricConfig>;
  replace(config: ConfigInput): Promise<DoricConfig>;
};

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
            ...provider,
          })),
        });
        await transaction.modelConfiguration.createMany({
          data: modelRows(config),
        });
        const stored = await transaction.doricConfiguration.update({
          where: { id: singletonId },
          data: {
            revision: { increment: 1 },
            generation: randomUUID(),
            maxTurns: config.execution.maxTurns,
          },
          include: { providers: true, models: true },
        });
        return fromStored(stored);
      },
      { isolationLevel: 'Serializable' },
    );
  },
});

const modelRows = (config: ConfigInput) => [modelRow(config.models.execution)];

const modelRow = (profile: ConfigInput['models']['execution']) => ({
  configurationId: singletonId,
  role: ModelRole.EXECUTION,
  providerId: profile.providerId,
  model: profile.model,
  effort: profile.effort,
});

const fromStored = (stored: StoredConfig): DoricConfig => {
  const models = new Map(stored.models.map((model) => [model.role, model]));
  const reasoning = (role: ModelRole) => {
    const profile = required(models, role);
    return {
      providerId: profile.providerId,
      model: profile.model,
      effort: profile.effort as ConfigInput['models']['execution']['effort'],
    };
  };

  const configuration = ConfigInputSchema.parse({
    providers: stored.providers
      .map(({ id, baseUrl, apiKeyEnv }) => ({ id, baseUrl, apiKeyEnv }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    models: {
      execution: reasoning(ModelRole.EXECUTION),
    },
    execution: { maxTurns: stored.maxTurns },
  });

  return {
    configuration,
    revision: stored.revision,
    updatedAt: stored.updatedAt.toISOString(),
  };
};

const required = <Value>(
  values: ReadonlyMap<ModelRole, Value>,
  role: ModelRole,
): Value => {
  const value = values.get(role);
  if (value === undefined)
    throw new Error(`Stored Doric model role is missing: ${role}`);
  return value;
};
