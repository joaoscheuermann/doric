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
          data: [
            {
              configurationId: singletonId,
              role: ModelRole.EXECUTION,
              providerId: config.models.execution.providerId,
              model: config.models.execution.model,
              effort: config.models.execution.effort,
            },
          ],
        });
        const stored = await transaction.doricConfiguration.update({
          where: { id: singletonId },
          data: {
            revision: { increment: 1 },
            generation: randomUUID(),
            maxTurns: config.execution.maxTurns,
            githubUsername: config.github?.username ?? null,
            githubEmail: config.github?.email ?? null,
            githubToken: config.github?.token ?? null,
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

  const github = githubFrom(stored);
  const configuration = ConfigInputSchema.parse({
    providers: stored.providers
      .map(({ id, baseUrl, apiKeyEnv }) => ({ id, baseUrl, apiKeyEnv }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    models: {
      execution: {
        providerId: execution.providerId,
        model: execution.model,
        effort: execution.effort,
      },
    },
    execution: { maxTurns: stored.maxTurns },
    ...(github === undefined ? {} : { github }),
  });

  return {
    configuration,
    revision: stored.revision,
    updatedAt: stored.updatedAt.toISOString(),
  };
};

/**
 * An identity without both of its public fields is not configurable, so an
 * incomplete pair reads back as unconfigured.
 */
const githubFrom = ({
  githubUsername,
  githubEmail,
  githubToken,
}: StoredConfig): ConfigInput['github'] => {
  if (githubUsername === null || githubEmail === null) return undefined;

  return {
    username: githubUsername,
    email: githubEmail,
    ...(githubToken === null ? {} : { token: githubToken }),
  };
};
