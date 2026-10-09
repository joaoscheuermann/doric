import type { EmbeddedBundle } from 'bundle';
import {
  defineSettings,
  type HostContext,
  SecretsV1,
  type SecretsView,
  SettingsV1,
} from 'bundle/contracts';

import {
  type ConfigInput,
  ConfigInputSchema,
  providerCredentials,
} from '../config/schema.js';

/** The settings space that holds the Doric configuration. */
export const configurationSettingsId = 'host-config.configuration/v1';

/**
 * Every credential a configuration references, as the old foreign keys did:
 * each provider's `secret` fields, the Git identity and the GitHub token.
 */
export const referencedCredentialIds = (
  configuration: ConfigInput,
): string[] => [
  ...configuration.providers.flatMap((provider) =>
    providerCredentials(provider).map(({ id }) => id),
  ),
  ...(configuration.gitCredentialId === undefined
    ? []
    : [configuration.gitCredentialId]),
  ...(configuration.githubCredentialId === undefined
    ? []
    : [configuration.githubCredentialId]),
];

const configurationSchema = (view: () => SecretsView | undefined) =>
  ConfigInputSchema.superRefine((configuration, context) => {
    // A configuration may only name stored credentials. The write runs in the
    // core's write queue, so a delete cannot land between this and the commit.
    const stored = view()?.list();

    for (const id of referencedCredentialIds(configuration))
      if (stored === undefined || !stored.some((entry) => entry.id === id))
        context.addIssue({
          code: 'custom',
          message:
            'The configuration references a credential that is not stored.',
        });
  });

export type ConfigurationSettings = ReturnType<
  typeof defineConfigurationSettings
>;

const defineConfigurationSettings = (view: () => SecretsView | undefined) =>
  defineSettings({
    id: configurationSettingsId,
    schema: configurationSchema(view),
  });

/**
 * The provisional owner of the configuration space until stage 10, when its
 * parts move to their owners. It registers the space, follows every write to
 * it, and names the credentials the stored configuration references, so
 * `secrets/v1` refuses to delete them.
 */
export interface HostConfig {
  /** Embedded bundle `host-config`, always enabled outside the composition. */
  readonly bundle: EmbeddedBundle;
  /** The space's definition, for `settings/v1` reads and writes. */
  readonly definition: ConfigurationSettings;
  /** Seeds the references with the configuration the host loaded. */
  track(configuration: ConfigInput): void;
}

const id = 'host-config';
const version = '0.0.0';
const contractVersion = '1.0.0';

export const createHostConfig = (): HostConfig => {
  let view: (() => SecretsView) | undefined;
  let latest: ConfigInput | undefined;
  const definition = defineConfigurationSettings(() => {
    try {
      return view?.();
    } catch {
      // Credentials that are not loaded yet hold nothing to reference.
      return undefined;
    }
  });

  return {
    definition,
    track: (configuration) => {
      latest = configuration;
    },
    bundle: {
      manifest: {
        manifestVersion: 1,
        id,
        version,
        engines: { doric: '^1.0.0' },
        description:
          'Provisional owner of the Doric configuration settings space.',
        provides: [`${configurationSettingsId}@${contractVersion}`],
        requires: ['settings/v1@^1.0.0', 'secrets/v1@^1.0.0'],
      },
      descriptor: {
        descriptorVersion: 1,
        bundle: { id, version },
        contracts: [
          {
            id: configurationSettingsId,
            version: contractVersion,
            kind: 'settings',
            environment: 'host',
            cardinality: 'one',
            local: false,
            schema: `schemas/${configurationSettingsId}.json`,
          },
        ],
      },
      host: {
        activate: ({ services }: HostContext) => {
          const settings = services.use(SettingsV1);
          const secrets = services.use(SecretsV1);

          view = () => secrets.view();
          settings.register(definition);
          settings.subscribe(definition, (entry) => {
            latest = entry.value;
          });
          secrets.registerReferences(() =>
            latest === undefined ? [] : referencedCredentialIds(latest),
          );
        },
      },
    },
  };
};
