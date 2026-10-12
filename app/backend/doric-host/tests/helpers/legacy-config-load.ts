import {
  type ConfigInput,
  ConfigInputSchema,
  type DoricConfig,
} from 'host-config/testing';
import { type ProviderField, providerKind } from 'llms';
import type { Database } from 'postgres/prisma';

// A frozen copy of the configuration store as it was before the configuration
// moved into a `settings/v1` space, over raw SQL because the generated client
// no longer has its tables. Tests use it as the oracle the new store must
// match byte for byte. Do not change it with the store.

interface ConfigurationRow {
  readonly revision: number;
  readonly max_turns: number;
  readonly max_tool_result_chars: number | null;
  readonly tool_config: unknown;
  readonly git_credential_id: string | null;
  readonly github_credential_id: string | null;
  readonly updated_at: Date;
}

interface ProviderRow {
  readonly id: string;
  readonly kind: string;
  readonly field_values: unknown;
  readonly credential_id: string | null;
  readonly models: unknown;
}

interface ModelRow {
  readonly role: string;
  readonly provider_id: string;
  readonly model: string;
  readonly effort: string | null;
}

interface ProviderModelInput {
  readonly name: string;
  readonly reasonings?: readonly string[];
}

type Queries = Pick<Database, '$queryRaw'>;

const secretField = (kindId: string): ProviderField | undefined =>
  providerKind(kindId)?.fields.find((field) => field.kind === 'secret');

const providerFromStored = (stored: ProviderRow) => {
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
      ...(stored.field_values as Readonly<Record<string, string>>),
      ...(secret === undefined || stored.credential_id === null
        ? {}
        : { [secret.key]: stored.credential_id }),
    },
    ...(models !== undefined &&
    (models.length > 0 || kind.lists.includes('models'))
      ? { models }
      : {}),
  };
};

/** `createConfigStore(database).load()` as it was, over the old tables. */
export const legacyLoad = async (database: Queries): Promise<DoricConfig> => {
  const [stored] = await database.$queryRaw<ConfigurationRow[]>`
    SELECT revision, max_turns, max_tool_result_chars, tool_config,
           git_credential_id::text AS git_credential_id,
           github_credential_id::text AS github_credential_id, updated_at
    FROM doric_configuration WHERE id = 1`;
  if (stored === undefined) throw new Error('No DoricConfiguration found');

  const providers = await database.$queryRaw<ProviderRow[]>`
    SELECT id, kind, field_values, credential_id::text AS credential_id, models
    FROM provider_configuration WHERE configuration_id = 1`;
  const models = await database.$queryRaw<ModelRow[]>`
    SELECT role::text AS role, provider_id, model, effort
    FROM model_configuration WHERE configuration_id = 1`;
  const execution = models.find(({ role }) => role === 'EXECUTION');
  if (execution === undefined)
    throw new Error('Stored Doric model role is missing: EXECUTION');

  const configuration = ConfigInputSchema.parse({
    providers: providers
      .map(providerFromStored)
      .sort((left, right) => left.id.localeCompare(right.id)),
    models: {
      execution: {
        providerId: execution.provider_id,
        model: execution.model,
        ...(execution.effort === null ? {} : { effort: execution.effort }),
      },
    },
    execution: {
      maxTurns: stored.max_turns,
      ...(stored.max_tool_result_chars === null
        ? {}
        : { maxToolResultChars: stored.max_tool_result_chars }),
    },
    tools: stored.tool_config as Readonly<
      Record<string, Readonly<Record<string, string>>>
    >,
    ...(stored.git_credential_id === null
      ? {}
      : { gitCredentialId: stored.git_credential_id }),
    ...(stored.github_credential_id === null
      ? {}
      : { githubCredentialId: stored.github_credential_id }),
  });

  return {
    configuration,
    revision: stored.revision,
    updatedAt: stored.updated_at.toISOString(),
  };
};

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

/** `createConfigStore(database).replace(config)` as it was, over the old tables. */
export const legacyReplace = (
  database: Database,
  config: ConfigInput,
): Promise<DoricConfig> =>
  database.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`
        DELETE FROM model_configuration WHERE configuration_id = 1`;
      await transaction.$executeRaw`
        DELETE FROM provider_configuration WHERE configuration_id = 1`;
      for (const provider of config.providers.map(providerRow))
        await transaction.$executeRaw`
          INSERT INTO provider_configuration
            (configuration_id, id, kind, field_values, credential_id, models)
          VALUES (1, ${provider.id}, ${provider.kind},
                  ${JSON.stringify(provider.fieldValues)}::jsonb,
                  ${provider.credentialId}::uuid,
                  ${JSON.stringify(provider.models)}::jsonb)`;
      await transaction.$executeRaw`
        INSERT INTO model_configuration
          (configuration_id, role, provider_id, model, effort)
        VALUES (1, 'EXECUTION', ${config.models.execution.providerId},
                ${config.models.execution.model},
                ${config.models.execution.effort ?? null})`;
      await transaction.$executeRaw`
        UPDATE doric_configuration SET
          revision = revision + 1,
          generation = gen_random_uuid(),
          max_turns = ${config.execution.maxTurns},
          max_tool_result_chars = ${config.execution.maxToolResultChars ?? null}::integer,
          tool_config = ${JSON.stringify(config.tools ?? {})}::jsonb,
          git_credential_id = ${config.gitCredentialId ?? null}::uuid,
          github_credential_id = ${config.githubCredentialId ?? null}::uuid,
          updated_at = ${new Date()}
        WHERE id = 1`;

      return legacyLoad(transaction);
    },
    { isolationLevel: 'Serializable' },
  );
