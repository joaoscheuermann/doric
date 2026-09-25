import { z } from 'zod';

const effort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const identifier = z.string().trim().min(1).max(128);
const model = z.string().trim().min(1).max(512);
const limit = z.number().int().safe().positive();

const provider = z
  .object({
    id: identifier,
    baseUrl: z
      .url()
      .refine(
        (value) => value.startsWith('http://') || value.startsWith('https://'),
        {
          message: 'Provider baseUrl must use HTTP or HTTPS.',
        },
      ),
    apiKeyEnv: z
      .string()
      .regex(
        /^[A-Z][A-Z0-9_]*_API_KEY$/u,
        'Invalid provider API key environment name.',
      ),
  })
  .strict();

const reasoningModel = z
  .object({
    providerId: identifier,
    model,
    effort,
  })
  .strict();

const providers = z.array(provider).min(1);

const models = z.object({ execution: reasoningModel }).strict();

const execution = z.object({ maxTurns: limit }).strict();

const githubToken = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/[\r\n]/u.test(value), {
    message: 'A GitHub token cannot contain line breaks.',
  });

const githubFields = {
  username: z.string().trim().min(1).max(128),
  email: z.string().trim().max(256).pipe(z.email()),
};

const github = z
  .object({ ...githubFields, token: githubToken.optional() })
  .strict();

/** `null` and an absent token keep the stored one; `''` clears it. */
const githubUpdate = z
  .object({
    ...githubFields,
    token: z.union([githubToken, z.literal(''), z.null()]).optional(),
  })
  .strict();

type ProviderReferences = {
  readonly providers: readonly { readonly id: string }[];
  readonly models: { readonly execution: { readonly providerId: string } };
};

/** Provider IDs stay unique and every model profile references a known one. */
const referencesKnownProviders = (
  value: ProviderReferences,
  context: z.RefinementCtx,
): void => {
  const ids = new Set<string>();

  value.providers.forEach(({ id }, index) => {
    if (ids.has(id)) {
      context.addIssue({
        code: 'custom',
        message: 'Provider IDs must be unique.',
        path: ['providers', index, 'id'],
      });
    }

    ids.add(id);
  });

  if (!ids.has(value.models.execution.providerId)) {
    context.addIssue({
      code: 'custom',
      message: 'Model references an unavailable provider.',
      path: ['models', 'execution', 'providerId'],
    });
  }
};

/**
 * Complete configuration exactly as the host persists it.
 *
 * The GitHub token is the single secret the stored configuration holds, and it
 * is write-only over the API: `ConfigUpdateSchema` is the only shape that
 * accepts one from a client, and `publicConfig` answers `hasToken` in its
 * place, because Configuration routes are unauthenticated. The host redacts the
 * value from events and logs and never hands it to a tool.
 */
export const ConfigInputSchema = z
  .object({ providers, models, execution, github: github.optional() })
  .strict()
  .superRefine(referencesKnownProviders);

/**
 * The `PUT /config` body. The GitHub block follows one rule for both itself and
 * its token: absent means "leave it alone", `null` means "remove it", and a
 * value means "set it". A secret therefore cannot be deleted by omission, and a
 * caller that does not know the field leaves it intact.
 */
export const ConfigUpdateSchema = z
  .object({
    providers,
    models,
    execution,
    github: githubUpdate.nullable().optional(),
  })
  .strict()
  .superRefine(referencesKnownProviders);

export type ConfigInput = z.output<typeof ConfigInputSchema>;

export type ConfigUpdate = z.output<typeof ConfigUpdateSchema>;

export type DoricConfig = {
  readonly configuration: ConfigInput;
  readonly revision: number;
  readonly updatedAt: string;
};

export type PublicGithub = {
  readonly username: string;
  readonly email: string;
  readonly hasToken: boolean;
};

export type PublicConfig = {
  readonly configuration: Omit<ConfigInput, 'github'> & {
    readonly github?: PublicGithub;
  };
  readonly revision: number;
  readonly updatedAt: string;
};

/** The API view of a snapshot: the GitHub token becomes `hasToken`. */
export const publicConfig = (snapshot: DoricConfig): PublicConfig => {
  const { github: configured, ...configuration } = snapshot.configuration;

  return {
    ...snapshot,
    configuration: {
      ...configuration,
      ...(configured === undefined
        ? {}
        : {
            github: {
              username: configured.username,
              email: configured.email,
              hasToken: configured.token !== undefined,
            },
          }),
    },
  };
};

export const defaultConfig: ConfigInput = {
  providers: [
    {
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
    },
  ],
  models: {
    execution: {
      providerId: 'openrouter',
      model: 'deepseek/deepseek-v4-flash-0731',
      effort: 'low',
    },
  },
  execution: { maxTurns: 32 },
};
