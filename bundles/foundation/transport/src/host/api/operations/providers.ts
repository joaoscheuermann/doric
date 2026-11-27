import type {
  CatalogModel,
  ModelField,
  ModelKindDescriptor,
} from 'bundle/contracts';
import { z } from 'zod';

import type { ApiAnswer, RouteInput } from '../answer.js';
import { ok, refused } from '../input.js';
import type { TransportPorts } from '../ports.js';

type Op<V> = (input: RouteInput) => Promise<ApiAnswer<V>>;

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
 * The `/providers` route bodies over the ports: the provider kinds this host
 * can configure, as `models/v1` lists them (the llms catalog unchanged), and
 * the one provider question a settings surface cannot answer locally: what a
 * draft's model catalog lists.
 */
export const providerOperations = ({
  models,
}: Pick<TransportPorts, 'models'>): {
  /** `GET /providers/kinds`. */
  readonly kinds: Op<{ readonly kinds: readonly ModelKindDescriptor[] }>;
  /** `POST /providers/models`. */
  readonly models: Op<{ readonly models: readonly CatalogModel[] }>;
} => ({
  kinds: async () => ok({ kinds: await models.kinds() }),
  models: async ({ body }) => {
    const parsed = draftInput.safeParse(body);
    const kind = parsed.success
      ? await models.kind(parsed.data.kind)
      : undefined;

    if (
      !parsed.success ||
      kind === undefined ||
      !fieldsAccepted(kind, parsed.data.configuration)
    ) {
      return refused({
        status: 422,
        code: 'invalid_provider',
        message: 'The provider values are invalid.',
      });
    }

    const read = await models.catalog({
      kind: kind.id,
      configuration: parsed.data.configuration,
    });

    if (read.status !== 'read') {
      return refused({
        status: 502,
        code: 'model_catalog_unreadable',
        message: 'The provider model catalog could not be read.',
      });
    }

    return ok({ models: read.models });
  },
});
