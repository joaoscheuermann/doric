/**
 * What the settings surfaces ask the host about icons (`models/v1.icons`), and
 * how they read its answers back by provider id, which never leaves the
 * renderer.
 */

import {
  MODEL_ICON_MAX_MODELS,
  MODEL_ICON_MAX_NAME,
  type ModelIconAnswers,
} from 'bundle/contracts';

import type { Configuration, ProviderConfiguration } from './config.js';

/**
 * What one provider is asked: its id, which stays in the renderer, its kind,
 * its values and some of its model names.
 */
export type IconRequest = {
  readonly providerId: string;
  readonly kind: string;
  readonly configuration: Readonly<Record<string, string>>;
  readonly models: readonly string[];
};

/**
 * The icons a surface draws, read by provider id: the SVG of a provider's own
 * icon, or of a model's icon after the host's fallback. Either answers
 * `undefined` for an id or a name it was not asked about, or that has no icon.
 */
export type IconLookup = {
  readonly provider: (providerId: string) => string | undefined;
  readonly model: (providerId: string, model: string) => string | undefined;
};

/** The lookup that knows no icon: every read answers `undefined`. */
export const noIcons: IconLookup = {
  provider: () => undefined,
  model: () => undefined,
};

/**
 * One request per provider, in configuration order, with that provider's kind
 * and values. Each request lists the provider's own model names in list
 * order, then the execution model, when this provider is the execution
 * provider, the model is not empty and the provider does not list it. Names
 * longer than `MODEL_ICON_MAX_NAME` are left out, so their rows draw no icon.
 * Of what remains, only each provider's first `MODEL_ICON_MAX_MODELS` names
 * are asked. No providers means no requests. It never throws.
 */
export const modelIconRequests = (
  configuration: Configuration,
): readonly IconRequest[] => {
  const { providerId, model } = configuration.models.execution;

  return configuration.providers.map((provider) => {
    const listed = (provider.models ?? []).map((entry) => entry.name);
    const names =
      provider.id === providerId && model !== '' && !listed.includes(model)
        ? [...listed, model]
        : listed;

    return {
      providerId: provider.id,
      kind: provider.kind,
      configuration: provider.configuration,
      models: names
        .filter((name) => name.length <= MODEL_ICON_MAX_NAME)
        .slice(0, MODEL_ICON_MAX_MODELS),
    };
  });
};

/**
 * The request for a provider's own icon, with no models: its id, kind and
 * values as they are. It is used by the dashboard rows and the provider page.
 * A draft not saved yet (`id: ''`) is asked about by its kind and values like
 * any other.
 */
export const providerIconRequest = (
  provider: ProviderConfiguration,
): IconRequest => ({
  providerId: provider.id,
  kind: provider.kind,
  configuration: provider.configuration,
  models: [],
});

/**
 * The lookup over `answers` and the `requests` they answered, index for
 * index; each icon name is read through `answers.svgs`. A provider id asked
 * twice uses its first request; a model listed twice uses its first place. A
 * provider or model not asked about, a model answered `null` and a provider
 * answered no own icon all read as `undefined`. It never throws.
 */
export const iconLookupFrom = (
  requests: readonly IconRequest[],
  answers: ModelIconAnswers,
): IconLookup => {
  const svgOf = (name: string | null | undefined): string | undefined =>
    name === null || name === undefined || !Object.hasOwn(answers.svgs, name)
      ? undefined
      : answers.svgs[name];

  const providers = new Map<string, string | undefined>();
  const models = new Map<string, Map<string, string | undefined>>();

  requests.forEach((request, index) => {
    if (providers.has(request.providerId)) return;
    const answer = answers.answers[index];
    providers.set(request.providerId, svgOf(answer?.provider));

    const own = new Map<string, string | undefined>();
    request.models.forEach((model, place) => {
      if (!own.has(model)) own.set(model, svgOf(answer?.models[place]));
    });
    models.set(request.providerId, own);
  });

  return {
    provider: (providerId) => providers.get(providerId),
    model: (providerId, model) => models.get(providerId)?.get(model),
  };
};
