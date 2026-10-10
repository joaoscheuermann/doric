import type { EmbeddedBundle } from 'bundle';
import {
  defineMethod,
  defineService,
  defineSettings,
  type HostContext,
  ModelsV1,
  type RegisteredTool,
  SecretsV1,
  type SecretsView,
  SettingsV1,
  ToolsV1,
} from 'bundle/contracts';
import { ConfigurationV1, configurationMethods } from 'runtime/contracts';
import { type BoundTool, isBoundTool } from 'tool';

import {
  type ConfigInput,
  ConfigInputSchema,
  providerCredentials,
} from '../config/schema.js';
import { createConfigService } from '../config/service.js';
import { createConfigStore } from '../config/store.js';
import {
  type CredentialService,
  createCredentialService,
} from '../credentials/service.js';

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

/** The tools a registry lists, as the `tool` package's bound factories. */
export const boundTools = (
  tools: readonly RegisteredTool[],
): readonly BoundTool[] =>
  tools.map(({ tool }) => {
    if (!isBoundTool(tool))
      throw new TypeError(
        `Tool "${tool.name}" was not defined with defineTool.`,
      );
    return tool;
  });

/**
 * The provisional owner of the configuration until stage 10, when its parts
 * move to their owners. It registers the settings space, follows every write
 * to it, and names the credentials the stored configuration references, so
 * `secrets/v1` refuses to delete them. It also provides `host-config/v1`
 * (X-6): the active configuration and the PUT /config pipeline.
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

  const track = (configuration: ConfigInput) => {
    latest = configuration;
  };

  return {
    definition,
    track,
    bundle: {
      manifest: {
        manifestVersion: 1,
        id,
        version,
        engines: { doric: '^1.0.0' },
        description:
          'Provisional owner of the Doric configuration settings space.',
        provides: [
          `${configurationSettingsId}@${contractVersion}`,
          `${ConfigurationV1.id}@${contractVersion}`,
        ],
        requires: [
          'settings/v1@^1.0.0',
          'secrets/v1@^1.0.0',
          'models/v1@^1.0.0',
          'tools/v1@^1.0.0',
        ],
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
          {
            id: ConfigurationV1.id,
            version: contractVersion,
            kind: 'service',
            environment: 'host',
            cardinality: 'one',
            local: false,
            schema: `schemas/${ConfigurationV1.id}.json`,
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

          let credentials: Promise<CredentialService> | undefined;
          const service = createConfigService({
            store: createConfigStore({ settings, definition, track }),
            // Loading the list fails while the credentials cannot be read,
            // so a later call tries again.
            credentials: () => {
              credentials ??= createCredentialService({ secrets }).catch(
                (error: unknown) => {
                  credentials = undefined;
                  throw error;
                },
              );

              return credentials;
            },
            tools: () => boundTools(services.use(ToolsV1).list()),
            models: services.use(ModelsV1),
          });

          services.provide(
            defineService(ConfigurationV1.id, {
              current: defineMethod({
                ...configurationMethods.current,
                execute: () => service.current(),
              }),
              replace: defineMethod({
                ...configurationMethods.replace,
                execute: (input: unknown) => service.replace(input),
              }),
            }),
          );
        },
      },
    },
  };
};
