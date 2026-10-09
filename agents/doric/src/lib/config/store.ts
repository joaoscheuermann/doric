import type { Settings, SettingsEntry } from 'bundle/contracts';
import { providerKind } from 'llms';

import type { ConfigurationSettings } from '../bundles/configuration.js';
import { jsonbKeyOrder } from './order.js';
import {
  type ConfigInput,
  ConfigInputSchema,
  type DoricConfig,
} from './schema.js';

export interface ConfigStore {
  load(): Promise<DoricConfig>;
  replace(config: ConfigInput): Promise<DoricConfig>;
}

interface Options {
  /** The `settings/v1` provider that holds the configuration space. */
  readonly settings: Settings;
  readonly definition: ConfigurationSettings;
  /** Told the configuration the host loaded, so its references are known. */
  readonly track: (configuration: ConfigInput) => void;
}

type ProviderInput = ConfigInput['providers'][number];

const byId = (left: { id: string }, right: { id: string }): number =>
  left.id.localeCompare(right.id);

/** The key of the one `secret` field a provider kind declares, if any. */
const secretKey = (kindId: string): string | undefined =>
  providerKind(kindId)?.fields.find((field) => field.kind === 'secret')?.key;

/**
 * One provider as the old provider row read back: its non-secret values in
 * jsonb order, then the credential its `secret` field names.
 */
const provider = (stored: ProviderInput): ProviderInput => {
  const secret = secretKey(stored.kind);
  const values = Object.fromEntries(
    Object.entries(stored.configuration).filter(([key]) => key !== secret),
  );
  const credentialId =
    secret === undefined ? undefined : stored.configuration[secret];

  return {
    id: stored.id,
    kind: stored.kind,
    configuration: {
      ...jsonbKeyOrder(values),
      ...(secret === undefined || credentialId === undefined
        ? {}
        : { [secret]: credentialId }),
    },
    ...(stored.models === undefined ? {} : { models: stored.models }),
  };
};

/**
 * The configuration space as `GET /config` has always answered it. The old
 * store read rows back from PostgreSQL, so providers come in `localeCompare`
 * order of their IDs, record keys in jsonb order with each provider's
 * credential last, and `tools` is always present; the schema then emits every
 * object in its own shape order. Reading and writing both pass through here,
 * so the two bodies stay identical byte for byte.
 */
const fromSettings = (entry: SettingsEntry<ConfigInput>): DoricConfig => {
  const value = entry.value;

  return {
    configuration: ConfigInputSchema.parse({
      providers: value.providers.map(provider).sort(byId),
      models: value.models,
      execution: value.execution,
      tools: jsonbKeyOrder(
        Object.fromEntries(
          Object.entries(value.tools ?? {}).map(([tool, fields]) => [
            tool,
            jsonbKeyOrder(fields),
          ]),
        ),
      ),
      ...(value.gitCredentialId === undefined
        ? {}
        : { gitCredentialId: value.gitCredentialId }),
      ...(value.githubCredentialId === undefined
        ? {}
        : { githubCredentialId: value.githubCredentialId }),
    }),
    revision: entry.revision,
    updatedAt: entry.updatedAt,
  };
};

/** What a write stores: providers in ID order and the tool values always set. */
const toSettings = (config: ConfigInput): ConfigInput => ({
  ...config,
  providers: [...config.providers].sort(byId),
  tools: config.tools ?? {},
});

/**
 * The singleton configuration as one `settings/v1` space. A replacement is one
 * settings write, serialized with credential writes by the provider, and its
 * revision is the next one.
 */
export const createConfigStore = ({
  settings,
  definition,
  track,
}: Options): ConfigStore => ({
  async load() {
    const config = fromSettings(await settings.entry(definition));

    track(config.configuration);
    return config;
  },

  async replace(config) {
    return fromSettings(await settings.set(definition, toSettings(config)));
  },
});
