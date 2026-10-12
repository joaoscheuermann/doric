import type { ModelField, ModelKindDescriptor, Models } from 'bundle/contracts';
import { Router } from 'express';
import { z } from 'zod';

import { sendError } from '../errors.js';

/*
 * agents/doric's `ProviderValuesSchema` over `models/v1.kind` instead of the
 * llms catalog: the same kind lookup (internal kinds included) and the same
 * field rule, so a value the configuration would refuse never reaches an
 * endpoint.
 */

const draftInput = z
  .object({
    kind: z.string().trim().min(1).max(128),
    configuration: z.record(z.string(), z.string()),
  })
  .strict();

/** Whether one declared value is one the field's kind accepts. */
const fieldAccepts = (field: ModelField, value: string): boolean => {
  switch (field.kind) {
    case 'url':
      return value.startsWith('http://') || value.startsWith('https://');
    case 'number':
      return Number.isFinite(Number(value));
    case 'enum':
      return field.options?.includes(value) === true;
    case 'secret':
      // The id of a stored credential: this reads the reference only.
      return z.uuid().safeParse(value).success;
    case 'text':
      return true;
  }
};

/**
 * The fields a kind declares are the fields a provider carries: every required
 * value present and non-empty, no unknown key, and an optional value either
 * absent or set, never empty.
 */
const fieldsAccepted = (
  kind: ModelKindDescriptor,
  configuration: Readonly<Record<string, string>>,
): boolean => {
  const declared = new Map(kind.fields.map((field) => [field.key, field]));

  for (const [key, entry] of Object.entries(configuration)) {
    const field = declared.get(key);

    if (field === undefined || entry.trim() === '') return false;
    if (!fieldAccepts(field, entry)) return false;
  }

  return kind.fields.every(
    (field) => !field.required || configuration[field.key] !== undefined,
  );
};

/**
 * The provider kinds this host can configure, as `models/v1` lists them (the
 * llms catalog unchanged), and the one provider question a settings surface
 * cannot answer locally: what a draft's model catalog lists.
 */
export const createProvidersRouter = (models: Models): Router => {
  const router = Router();

  router.get('/kinds', async (_request, response) => {
    response.json({ kinds: await models.kinds() });
  });

  router.post('/models', async (request, response) => {
    const parsed = draftInput.safeParse(request.body);
    const kind = parsed.success
      ? await models.kind(parsed.data.kind)
      : undefined;

    if (
      !parsed.success ||
      kind === undefined ||
      !fieldsAccepted(kind, parsed.data.configuration)
    ) {
      sendError(
        response,
        422,
        'invalid_provider',
        'The provider values are invalid.',
      );

      return;
    }

    const read = await models.catalog({
      kind: kind.id,
      configuration: parsed.data.configuration,
    });

    if (read.status !== 'read') {
      sendError(
        response,
        502,
        'model_catalog_unreadable',
        'The provider model catalog could not be read.',
      );

      return;
    }

    response.json({ models: read.models });
  });

  return router;
};
