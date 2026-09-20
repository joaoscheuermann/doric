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

/** Complete credential-free configuration accepted by the REST API. */
export const ConfigInputSchema = z
  .object({
    providers: z.array(provider).min(1),
    models: z
      .object({
        execution: reasoningModel,
      })
      .strict(),
    execution: z.object({ maxTurns: limit }).strict(),
  })
  .strict()
  .superRefine((value, context) => {
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
  });

export type ConfigInput = z.output<typeof ConfigInputSchema>;

export type DoricConfig = {
  readonly configuration: ConfigInput;
  readonly revision: number;
  readonly updatedAt: string;
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
