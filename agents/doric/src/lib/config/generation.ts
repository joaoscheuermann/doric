import type { Logger } from 'pino';

import type { Bundle, Skill } from 'bundle';
import {
  createFetchTransport,
  createOpenAiCompatibleProvider,
  type LlmProvider,
} from 'llms';
import type { ToolFactory } from 'tool';

import type { DoricConfig } from './schema.js';

export type Catalog = {
  readonly skills: readonly Skill[];
  readonly tools: readonly ToolFactory[];
};

export type Generation = {
  readonly snapshot: DoricConfig;
  readonly providers: ReadonlyMap<string, LlmProvider>;
  readonly redactions: () => readonly string[];
  readonly catalog: Catalog;
};

type GenerationOptions = {
  readonly snapshot: DoricConfig;
  readonly bundles: readonly Bundle[];
  readonly logger: Logger;
  readonly environment?: NodeJS.ProcessEnv;
};

/** Builds one provider and bundle generation captured by new Projects. */
export const createGeneration = async ({
  snapshot,
  bundles,
  logger,
  environment = process.env,
}: GenerationOptions): Promise<Generation> => {
  const credentials = new Set<string>();

  const credential = (name: string): string => {
    const value = environment[name] ?? '';

    if (value.length > 0) {
      credentials.add(value);
    }

    return value;
  };

  const providers = new Map(
    snapshot.configuration.providers.map((provider) => [
      provider.id,
      createOpenAiCompatibleProvider({
        transport: createFetchTransport(),
        baseUrl: provider.baseUrl,
        apiKey: () => credential(provider.apiKeyEnv),
        identity: { id: provider.id, name: provider.id },
        logger,
      }),
    ]),
  );

  const redactions = () => {
    snapshot.configuration.providers.forEach(({ apiKeyEnv }) =>
      credential(apiKeyEnv),
    );

    const token = snapshot.configuration.github?.token;
    // The stored GitHub token is the configuration's only secret, so no
    // persisted history, event, or log line may carry it.
    if (token !== undefined) credentials.add(token);

    return [...credentials];
  };

  return {
    snapshot,
    providers,
    redactions,
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
