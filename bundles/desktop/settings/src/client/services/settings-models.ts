// settings.models/v1 (bundle isolation 6(c)): the footer execution picker's
// data, computed from the settings' own rules, so the chat that draws the
// picker writes no rule again. The configuration is the window's
// `queryKeys.configSnapshot` query, observed while the service has a
// subscriber, so a save of the settings window or of the provider page
// reaches the footer; the icons are one `models/v1.icons` query per view.
//
// No DOM here: the client part hands the window's focus in as `onFocus`.

import {
  keepPreviousData,
  type QueryClient,
  QueryObserver,
  type QueryObserverOptions,
} from '@tanstack/react-query';
import { type Disposable, defineMethod, defineService } from 'bundle/contracts';
import type { ErrorInfo } from 'desktop/reads';
import { resolveThreadExecution } from 'runtime/contracts';

import {
  type ExecutionView,
  SettingsModelsV1,
  type StoredExecution,
  settingsModelsMethods,
  type ModelChoice as ViewChoice,
  type ModelGroup as ViewGroup,
} from '../../contracts/index.js';
import { api } from '../api/settings-api.js';
import {
  type Configuration,
  type DoricConfiguration,
  effortLabel,
  isReasoningEffort,
  type ModelExecution,
  modelChoiceKey,
  modelDefaultEffort,
  modelEfforts,
  modelGroups,
  selectModelChoice,
  setExecutionEffort,
  withExecution,
} from '../domain/config.js';
import {
  type IconLookup,
  type IconRequest,
  iconLookupFrom,
  iconsFrom,
  modelIconRequests,
  noIcons,
} from '../domain/model-icons.js';
import { failureInfo, keptFailure } from '../domain/read-failure.js';
import { queryKeys } from '../queries/keys.js';

export interface SettingsModelsOptions {
  /** The window's query client (`settingsQueryClient`). */
  readonly queryClient: () => QueryClient;
  /** Calls `listener` when the window regains focus; wired to `window` by the client part (O7). */
  readonly onFocus: (listener: () => void) => Disposable;
}

/** The most views kept at once, the least recently read evicted first. */
const KEPT_VIEWS = 8;

/** An execution with exactly its three fields, an effort only when it is one. */
const executionOf = (execution: {
  readonly providerId: string;
  readonly model: string;
  readonly effort?: string;
}): ModelExecution => {
  const { providerId, model, effort } = execution;
  return effort !== undefined && isReasoningEffort(effort)
    ? { providerId, model, effort }
    : { providerId, model };
};

/** The execution a view shows: `stored` resolved, or the default without one. */
const shownExecution = (
  configuration: Configuration,
  stored: StoredExecution | undefined,
): ModelExecution =>
  executionOf(
    stored === undefined
      ? configuration.models.execution
      : resolveThreadExecution(stored, configuration),
  );

/** The ready view of `configuration` for `stored`, its icons read from `icons`. */
const readyView = (
  configuration: Configuration,
  stored: StoredExecution | undefined,
  icons: IconLookup,
  state: { readonly error?: ErrorInfo; readonly reloading: boolean },
): ExecutionView => {
  const execution = shownExecution(configuration, stored);
  const { providerId, model, effort } = execution;
  const view = withExecution(configuration, execution);

  const groups = modelGroups(view, icons).map(
    (group): ViewGroup => ({
      ...(group.label === undefined ? {} : { label: group.label }),
      choices: group.choices.map(
        (choice): ViewChoice => ({
          label: choice.label,
          value: choice.value,
          ...(choice.icon === undefined ? {} : { icon: choice.icon }),
          execution: executionOf(
            selectModelChoice(view, choice.value).models.execution,
          ),
        }),
      ),
    }),
  );
  const defaultEffort = modelDefaultEffort(view, providerId, model);
  const efforts = modelEfforts(view, providerId, model)
    .filter((value) => value !== 'none')
    .map((value) => ({
      label: effortLabel(value),
      value,
      ...(value === defaultEffort ? { note: '(default)' } : {}),
      execution: executionOf(setExecutionEffort(view, value).models.execution),
    }));
  const icon = icons.model(providerId, model);

  return {
    status: 'ready',
    ...(state.error === undefined ? {} : { error: state.error }),
    reloading: state.reloading,
    execution,
    ...(icon === undefined ? {} : { icon }),
    value: modelChoiceKey(providerId, model),
    listsModels: configuration.providers.some(
      (provider) => (provider.models?.length ?? 0) > 0,
    ),
    groups,
    efforts,
    effortLabel:
      efforts.length === 0 ? 'Unavailable' : effortLabel(effort ?? 'none'),
    typedProviderId: configuration.providers.some(
      (provider) => provider.id === providerId,
    )
      ? providerId
      : configuration.models.execution.providerId,
  };
};

/** What a view was computed from; an equal set answers the same view. */
interface Inputs {
  readonly data: DoricConfiguration | undefined;
  readonly error: ErrorInfo | undefined;
  readonly reloading: boolean;
  readonly icons: IconLookup | undefined;
}

const sameInputs = (a: Inputs, b: Inputs): boolean =>
  a.data === b.data &&
  a.error === b.error &&
  a.reloading === b.reloading &&
  a.icons === b.icons;

/** One distinct `stored`, its icons read while the service is watched, and its last view. */
interface Entry {
  readonly stored: StoredExecution | undefined;
  icons?: QueryObserver<IconLookup>;
  stopIcons?: () => void;
  /** The configuration the icons observer asks for. */
  watched?: Configuration;
  computed?: { readonly inputs: Inputs; readonly view: ExecutionView };
}

/** The key of a `stored`, by its three fields; the default is a key of its own. */
const keyOf = (stored: StoredExecution | undefined): string =>
  stored === undefined
    ? 'default'
    : JSON.stringify([
        stored.providerId ?? null,
        stored.model ?? null,
        stored.effort ?? null,
      ]);

/** What the icons of `stored` are asked for: the requests of its view configuration. */
const requestsOf = (
  configuration: Configuration,
  stored: StoredExecution | undefined,
): readonly IconRequest[] =>
  modelIconRequests(
    withExecution(configuration, shownExecution(configuration, stored)),
  );

const iconOptions = (
  requests: readonly IconRequest[],
): QueryObserverOptions<IconLookup> => ({
  queryKey: queryKeys.modelIcons(requests),
  queryFn: async () =>
    iconLookupFrom(requests, await api().providers.icons(requests)),
  enabled: requests.length > 0,
  placeholderData: keepPreviousData,
});

/** The provider of `settings.models/v1` (`:1211-1229`) and its teardown, called before `clearSettingsQueryClient()`. */
export const createSettingsModels = ({
  queryClient,
  onFocus,
}: SettingsModelsOptions) => {
  const listeners = new Set<() => void>();
  const entries = new Map<string, Entry>();
  /** The observers that run while the service has a subscriber. */
  let live: { readonly stop: () => void } | undefined;
  /** The kept failure of the configuration read (`keptFailure`). */
  let kept: unknown;
  let info:
    | {
        readonly failure: unknown;
        readonly at: number;
        readonly value?: ErrorInfo;
      }
    | undefined;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('Doric: a settings.models listener failed:', error);
      }
    }
  };

  const snapshotOptions = {
    queryKey: queryKeys.configSnapshot,
    queryFn: () => api().config.get(),
  };

  /** The configuration read as the query cache holds it, its failure kept. */
  const snapshot = (): {
    readonly data: DoricConfiguration | undefined;
    readonly error: ErrorInfo | undefined;
    readonly reloading: boolean;
  } => {
    const state = queryClient().getQueryState<DoricConfiguration>(
      queryKeys.configSnapshot,
    );
    const status = state?.status ?? 'pending';
    const reloading = state?.fetchStatus === 'fetching';
    kept = keptFailure(kept, {
      isError: status === 'error',
      error: state?.error,
      isPending: status === 'pending',
      isFetching: reloading,
    });
    const at = state?.errorUpdatedAt ?? 0;
    const current =
      info !== undefined && info.failure === kept && info.at === at
        ? info
        : { failure: kept, at, value: failureInfo(kept, at) };
    info = current;
    return { data: state?.data, error: current.value, reloading };
  };

  const stopIcons = (entry: Entry): void => {
    entry.stopIcons?.();
    entry.stopIcons = undefined;
    entry.icons = undefined;
    entry.watched = undefined;
  };

  /** While watched, asks for the icons of `entry` over `configuration`. */
  const watchIcons = (
    entry: Entry,
    configuration: Configuration | undefined,
  ): void => {
    if (
      live === undefined ||
      configuration === undefined ||
      entry.watched === configuration
    )
      return;
    entry.watched = configuration;
    const options = iconOptions(requestsOf(configuration, entry.stored));
    if (entry.icons === undefined) {
      const observer = new QueryObserver<IconLookup>(queryClient(), options);
      entry.icons = observer;
      entry.stopIcons = observer.subscribe(notify);
    } else {
      entry.icons.setOptions(options);
    }
  };

  /** The icons of `entry`, read from its observer while watched, else from the cache. */
  const iconsOf = (
    entry: Entry,
    configuration: Configuration,
  ): IconLookup | undefined => {
    const requests = requestsOf(configuration, entry.stored);
    const state =
      entry.icons === undefined
        ? queryClient().getQueryState<IconLookup>(
            queryKeys.modelIcons(requests),
          )
        : undefined;
    const result = entry.icons?.getCurrentResult() ?? {
      isError: state?.status === 'error',
      data: state?.data,
    };
    return iconsFrom(requests.length > 0, {
      isError: result.isError,
      ...(result.data === undefined ? {} : { data: result.data }),
    });
  };

  /** The entry of `stored`, now the most recently read; the least recently read past eight leaves. */
  const entryOf = (stored: StoredExecution | undefined): Entry => {
    const key = keyOf(stored);
    const entry = entries.get(key) ?? { stored };
    entries.delete(key);
    entries.set(key, entry);
    for (const [oldest, evicted] of entries) {
      if (entries.size <= KEPT_VIEWS) break;
      stopIcons(evicted);
      entries.delete(oldest);
    }
    return entry;
  };

  const view = (stored: StoredExecution | undefined): ExecutionView => {
    const entry = entryOf(stored);
    const { data, error, reloading } = snapshot();
    const configuration = data?.configuration;
    watchIcons(entry, configuration);
    const icons =
      configuration === undefined ? undefined : iconsOf(entry, configuration);
    const inputs: Inputs = { data, error, reloading, icons };
    if (
      entry.computed !== undefined &&
      sameInputs(entry.computed.inputs, inputs)
    )
      return entry.computed.view;

    const next: ExecutionView =
      configuration === undefined
        ? {
            status: 'loading',
            ...(error === undefined ? {} : { error }),
            reloading,
          }
        : readyView(configuration, entry.stored, icons ?? noIcons, {
            ...(error === undefined ? {} : { error }),
            reloading,
          });
    entry.computed = { inputs, view: next };
    return next;
  };

  const reload = (): void => {
    void queryClient().refetchQueries(
      { queryKey: queryKeys.configSnapshot, exact: true },
      { cancelRefetch: false },
    );
  };

  const start = (): void => {
    const observer = new QueryObserver<DoricConfiguration>(
      queryClient(),
      snapshotOptions,
    );
    const unsubscribe = observer.subscribe(() => {
      // A new configuration asks every kept view's icons again at once.
      const configuration = snapshot().data?.configuration;
      for (const entry of entries.values()) watchIcons(entry, configuration);
      notify();
    });
    const focus = onFocus(reload);
    live = {
      stop: () => {
        focus.dispose();
        unsubscribe();
        for (const entry of entries.values()) stopIcons(entry);
      },
    };
    // The default view is the one a footer reads first: its icons are asked
    // for as soon as the configuration lands.
    entryOf(undefined);
  };

  const stop = (): void => {
    const current = live;
    live = undefined;
    current?.stop();
  };

  const subscribe = (listener: () => void): Disposable => {
    listeners.add(listener);
    if (live === undefined) start();
    let active = true;
    return {
      dispose: () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      },
    };
  };

  return {
    service: defineService(SettingsModelsV1, {
      view: defineMethod({
        ...settingsModelsMethods.view,
        execute: ([stored]) => view(stored),
      }),
      subscribe: defineMethod({
        ...settingsModelsMethods.subscribe,
        execute: (listener: () => void) => subscribe(listener),
      }),
      reload: defineMethod({
        ...settingsModelsMethods.reload,
        execute: () => reload(),
      }),
    }),
    dispose: (): void => {
      listeners.clear();
      stop();
      entries.clear();
    },
  };
};
