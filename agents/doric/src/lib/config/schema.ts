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
    /** The stored `API_TOKEN` credential that authenticates this provider. */
    credentialId: z.uuid(),
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
 * A provider and each of the two GitHub-related integrations name a stored
 * credential by id, and the stored configuration holds no secret of its own, so
 * `GET /config` answers the same shape `PUT /config` accepts. An absent choice is
 * the unconfigured form, and the service refuses a reference that names a
 * missing credential or the wrong kind before it is activated.
 */
export const ConfigInputSchema = z
  .object({
    providers,
    models,
    execution,
    gitCredentialId: z.uuid().optional(),
    githubCredentialId: z.uuid().optional(),
  })
  .strict()
  .superRefine(referencesKnownProviders);

export type ConfigInput = z.output<typeof ConfigInputSchema>;

export type DoricConfig = {
  readonly configuration: ConfigInput;
  readonly revision: number;
  readonly updatedAt: string;
};

/**
 * The credential the baseline migration seeds for the seeded provider, so the
 * stored configuration and this default agree.
 */
const baselineCredentialId = '00000000-0000-4000-8000-000000000002';

export const defaultConfig: ConfigInput = {
  providers: [
    {
      id: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      credentialId: baselineCredentialId,
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
