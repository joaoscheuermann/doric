import type {
  ModelIconAnswers,
  ModelIconChoice,
  ModelIconRequest,
  ModelsProvider,
} from 'bundle/contracts';
import { isModelIconName, type ModelIconName, modelIconSvg } from 'llms';

import { bounded, timedOut } from '../../shared/hooks.js';
import type { ProviderCache } from './providers.js';
import type { KindRegistry } from './registry.js';

/** How long the core waits for one provider record's `icons`. */
export const PROVIDER_ICONS_DEADLINE_MS = 1000;

/** One request's answer by icon name, before the names become SVGs. */
interface IconAnswer {
  readonly provider?: ModelIconName;
  readonly models: readonly (ModelIconName | null)[];
}

/**
 * A record's `icons`, within `deadlineMs`; a record that rejects or is late
 * answers `undefined`, like `capacityOf` turns a failure into none.
 */
const iconsOf = async (
  api: ModelsProvider,
  input: {
    readonly configuration: Readonly<Record<string, string>>;
    readonly models: readonly string[];
  },
  deadlineMs: number,
): Promise<ModelIconChoice | undefined> => {
  // `bounded` answers `unknown`, so the choice is kept as the record answers it.
  let choice: ModelIconChoice | undefined;

  try {
    const result = await bounded(async () => {
      choice = await api.icons(input);
    }, deadlineMs);
    return result === timedOut ? undefined : choice;
  } catch {
    return undefined;
  }
};

/** A name of the set, or none for anything else. */
const knownIcon = (name: string | null | undefined): ModelIconName | null =>
  name !== null && name !== undefined && isModelIconName(name) ? name : null;

/** The kind and values a request asks about, or none for an unknown provider. */
const targetOf = (
  cache: Pick<ProviderCache, 'configured'>,
  request: ModelIconRequest,
):
  | {
      readonly kind: string;
      readonly configuration: Readonly<Record<string, string>>;
    }
  | undefined => {
  if ('kind' in request) return request;

  return cache
    .configured()
    .find((provider) => provider.id === request.providerId);
};

const answerOf = async (
  registry: Pick<KindRegistry, 'find'>,
  cache: Pick<ProviderCache, 'configured'>,
  request: ModelIconRequest,
  deadlineMs: number,
): Promise<IconAnswer> => {
  const none: IconAnswer = { models: request.models.map(() => null) };
  const target = targetOf(cache, request);
  if (target === undefined) return none;

  const entry = await registry.find(target.kind);
  if (entry === undefined) return none;

  const choice = await iconsOf(
    entry.api,
    { configuration: target.configuration, models: request.models },
    deadlineMs,
  );
  if (choice === undefined || choice.models.length !== request.models.length)
    return none;

  const provider = knownIcon(choice.provider);
  const models = choice.models.map((name) => knownIcon(name) ?? provider);

  return provider === null ? { models } : { provider, models };
};

/**
 * `models/v1.icons` (1.3.0). Each request, in parallel: a `{ kind, configuration }`
 * request is its own target; a `{ providerId }` request takes that provider's kind
 * and values from `cache.configured()`. `registry.find(kind)` gives the record,
 * which is asked within `deadlineMs` (default `PROVIDER_ICONS_DEADLINE_MS`; 0 or
 * less waits without a deadline). A name `isModelIconName` refuses counts as
 * none; each model wears its own icon, else the provider's own, else `null`. A
 * request with no provider, no record, or a record that rejects, is late or
 * answers another number of models answers no `provider` and `null` per model.
 * `answers` has the requests' length and order; `svgs` holds exactly the names
 * used. Never rejects for those; reads no secret, builds no provider, keeps no
 * cache.
 */
export const modelIcons = async (
  registry: Pick<KindRegistry, 'find'>,
  cache: Pick<ProviderCache, 'configured'>,
  input: { readonly requests: readonly ModelIconRequest[] },
  options?: { readonly deadlineMs?: number },
): Promise<ModelIconAnswers> => {
  const deadlineMs = options?.deadlineMs ?? PROVIDER_ICONS_DEADLINE_MS;
  const answers = await Promise.all(
    input.requests.map((request) =>
      answerOf(registry, cache, request, deadlineMs),
    ),
  );
  const used = new Set(
    answers.flatMap(({ provider, models }) =>
      [provider, ...models].filter(
        (name): name is ModelIconName => name !== undefined && name !== null,
      ),
    ),
  );

  return {
    svgs: Object.fromEntries(
      [...used].map((name) => [name, modelIconSvg(name)]),
    ),
    answers: answers.map(({ provider, models }) => ({
      ...(provider === undefined ? {} : { provider }),
      models: [...models],
    })),
  };
};
