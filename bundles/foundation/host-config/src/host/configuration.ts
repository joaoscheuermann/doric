import { defineSettings, type SecretsView } from 'bundle/contracts';

import {
  type ConfigInput,
  ConfigInputSchema,
  providerCredentials,
} from './config/schema.js';

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
