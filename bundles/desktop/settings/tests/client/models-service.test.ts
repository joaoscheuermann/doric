// T6.3 (bundle isolation 6(c)): `settings.models/v1` through the contract, in
// a real settings window. A probe bundle plays the chat: it requires the
// contract and calls it through `services.use`, by id, as the chat does. The
// host's `host-config/v1` and `models/v1.icons` are the fakes; every rule of
// the view (the groups, the efforts, a Thread's execution, the icons) is the
// settings bundle's own, so each case states what the reader would see.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { type Disposable, ref, UiV1 } from 'bundle/contracts';

import {
  type HostAnswer,
  openSettingsWindow,
  type ProbeBundle,
  type SettingsWindow,
  settle,
} from './support/window.js';

/* ------------------------------------------------------------------ */
/* The contract, as the chat sees it (by id, types only)               */
/* ------------------------------------------------------------------ */

type Execution = {
  readonly providerId: string;
  readonly model: string;
  readonly effort?: string;
};

type Stored = {
  readonly providerId?: string;
  readonly model?: string;
  readonly effort?: string;
};

type Choice = {
  readonly label: string;
  readonly value: string;
  readonly icon?: string;
  readonly execution: Execution;
};

type Group = { readonly label?: string; readonly choices: readonly Choice[] };

type EffortChoice = {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  readonly execution: Execution;
};

type Ready = {
  readonly status: 'ready';
  readonly error?: unknown;
  readonly reloading: boolean;
  readonly execution: Execution;
  readonly icon?: string;
  readonly value: string;
  readonly listsModels: boolean;
  readonly groups: readonly Group[];
  readonly efforts: readonly EffortChoice[];
  readonly effortLabel: string;
  readonly typedProviderId: string;
};

type View =
  | {
      readonly status: 'loading';
      readonly error?: unknown;
      readonly reloading: boolean;
    }
  | Ready;

interface SettingsModels {
  view(stored?: Stored): View;
  subscribe(listener: () => void): Disposable;
  reload(): void;
}

const SettingsModelsV1 = ref<SettingsModels>('settings.models/v1');

/* ------------------------------------------------------------------ */
/* The host                                                            */
/* ------------------------------------------------------------------ */

const SONNET = 'anthropic/claude-sonnet-4';
const CODER = 'acme/coder-7b';
const THINKER = 'acme/thinker';

const openrouterToken = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'API_TOKEN',
  name: 'OpenRouter',
  hasSecret: true,
};

const kinds = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Hosted models.',
    fields: [
      { key: 'endpoint', label: 'Endpoint', kind: 'url', required: true },
      { key: 'token', label: 'Token', kind: 'secret', required: true },
    ],
    lists: ['models', 'reasonings'],
  },
  {
    id: 'openai',
    label: 'OpenAI compatible',
    description: 'Any OpenAI-compatible server.',
    fields: [
      { key: 'endpoint', label: 'Endpoint', kind: 'url', required: true },
    ],
    lists: ['models'],
  },
];

type ModelEntry = {
  readonly name: string;
  readonly reasonings?: readonly string[];
  readonly defaultEffort?: string;
};

/** The three models OpenRouter lists unless a test says otherwise. */
const listed: readonly ModelEntry[] = [
  { name: SONNET, reasonings: ['low', 'high'] },
  { name: CODER, reasonings: [] },
  {
    name: THINKER,
    reasonings: ['none', 'low', 'medium', 'high'],
    defaultEffort: 'medium',
  },
];

const openrouter = (models: readonly ModelEntry[] = listed) => ({
  id: 'openrouter',
  kind: 'openrouter',
  configuration: {
    endpoint: 'https://openrouter.ai/api/v1',
    token: openrouterToken.id,
  },
  models,
});

const lmstudio = (models: readonly ModelEntry[]) => ({
  id: 'lmstudio',
  kind: 'openai',
  configuration: { endpoint: 'http://localhost:1234/v1' },
  models,
});

const DEFAULT: Execution = {
  providerId: 'openrouter',
  model: SONNET,
  effort: 'high',
};

const configurationOf = (
  providers: readonly unknown[] = [openrouter()],
  execution: Execution = DEFAULT,
) => ({
  providers,
  models: { execution },
  execution: { maxTurns: 32 },
});

const snapshot = (configuration: unknown) => ({
  configuration,
  revision: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const svgs: Readonly<Record<string, string>> = {
  claude:
    '<svg id="fixture-icon-claude" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>',
};

type IconsInput = {
  readonly requests: readonly {
    readonly kind: string;
    readonly models: readonly string[];
  }[];
};

/** `models/v1.icons` as the host answers it: Claude for an `anthropic/` model, none for any other. */
const answerIcons = (input: unknown) => {
  const { requests } = input as IconsInput;
  return {
    svgs,
    answers: requests.map((request) => ({
      models: request.models.map((model) =>
        model.startsWith('anthropic/') ? 'claude' : null,
      ),
    })),
  };
};

/** A host whose configuration is `configuration`, icons answered. */
const host = (
  configuration: unknown = configurationOf(),
  answers: Readonly<Record<string, HostAnswer>> = {},
): Record<string, HostAnswer> => ({
  'host-config/v1.current': () => snapshot(configuration),
  'host-config/v1.replace': () => {
    throw new Error('settings.models/v1 wrote the workspace default.');
  },
  'models/v1.kinds': () => kinds,
  'models/v1.icons': answerIcons,
  'secrets/v1.list': () => [openrouterToken],
  'tools/v1.catalog': () => [],
  ...answers,
});

/** A promise the test settles by hand: a host answer still in flight. */
const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

/* ------------------------------------------------------------------ */
/* The window                                                          */
/* ------------------------------------------------------------------ */

let opened: SettingsWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

/**
 * Opens a settings window with a probe that requires `settings.models/v1`,
 * at a path no settings view draws, so the host reads the test counts are the
 * service's own. `alongside` names settings elements the probe mounts too.
 */
const open = async (
  answers: Record<string, HostAnswer>,
  alongside: readonly string[] = [],
): Promise<{ window: SettingsWindow; models: SettingsModels }> => {
  let models: SettingsModels | undefined;
  const probe: ProbeBundle = {
    requires: ['settings.models/v1@^1.0.0', 'ui/v1@^1.0.0'],
    activate: (context) => {
      models = context.services.use(SettingsModelsV1);
      const ui = context.services.use(UiV1);
      for (const tag of alongside) {
        document.body.append(ui.create(tag) as HTMLElement);
      }
    },
  };
  opened = await openSettingsWindow({
    url: 'doric://app/elsewhere',
    host: answers,
    probe,
  });
  await settle(20);
  assert.ok(
    models !== undefined,
    'No provider of settings.models/v1 reached a bundle that requires it.',
  );
  return { window: opened, models };
};

/** Subscribes, lets the first read land, and answers the subscription. */
const watching = async (
  models: SettingsModels,
): Promise<{ calls: () => number; dispose: () => void }> => {
  let calls = 0;
  const subscription = models.subscribe(() => {
    calls += 1;
  });
  await settle(20);
  return { calls: () => calls, dispose: () => subscription.dispose() };
};

const ready = (view: View): Ready => {
  assert.equal(view.status, 'ready', JSON.stringify(view));
  return view as Ready;
};

const reads = (window: SettingsWindow): number =>
  window.received('host-config/v1.current').length;

const choicesOf = (view: Ready): readonly Choice[] =>
  view.groups.flatMap((group) => group.choices);

const choiceOf = (view: Ready, model: string): Choice => {
  const found = choicesOf(view).find((choice) => choice.label === model);
  assert.ok(found !== undefined, `No choice reads ${model}.`);
  return found;
};

/* ------------------------------------------------------------------ */
/* 1. loading, then ready                                              */
/* ------------------------------------------------------------------ */

test('T6.3-1: before the first answer the view is loading and reloading, and after it ready, its subscribers called', async () => {
  const first = deferred<unknown>();
  const { models } = await open(
    host(undefined, { 'host-config/v1.current': () => first.promise }),
  );

  const watch = await watching(models);
  assert.deepEqual(models.view(), { status: 'loading', reloading: true });

  first.resolve(snapshot(configurationOf()));
  await settle(20);

  const view = ready(models.view());
  assert.equal(view.reloading, false);
  assert.equal(view.error, undefined);
  assert.ok(watch.calls() > 0, 'No subscriber heard the first answer.');
  watch.dispose();
});

/* ------------------------------------------------------------------ */
/* 2–4. the execution shown and the groups                             */
/* ------------------------------------------------------------------ */

test('T6.3-2: the default view shows the configured default, leaves a single provider unnamed, and its value is the shown choice', async () => {
  const { models } = await open(host());
  const watch = await watching(models);

  const view = ready(models.view());
  assert.deepEqual(view.execution, DEFAULT);
  assert.equal(view.groups.length, 1);
  assert.equal(view.groups[0]?.label, undefined);
  assert.deepEqual(
    view.groups[0]?.choices.map((choice) => choice.label),
    [SONNET, CODER, THINKER],
  );
  assert.equal(view.value, choiceOf(view, SONNET).value);
  assert.equal(
    new Set(choicesOf(view).map((choice) => choice.value)).size,
    3,
    'Two choices share a value.',
  );
  watch.dispose();
});

test('T6.3-2: with two providers every group carries its provider label', async () => {
  const { models } = await open(
    host(configurationOf([openrouter(), lmstudio([{ name: 'local-1' }])])),
  );
  const watch = await watching(models);

  const view = ready(models.view());
  assert.deepEqual(
    view.groups.map((group) => group.label),
    ['openrouter', 'lmstudio'],
  );
  assert.deepEqual(
    view.groups[1]?.choices.map((choice) => choice.label),
    ['local-1'],
  );
  watch.dispose();
});

test('T6.3-3: a stored execution on a listed model is the execution shown', async () => {
  const { models } = await open(host());
  const watch = await watching(models);

  const stored = { providerId: 'openrouter', model: SONNET, effort: 'low' };
  const view = ready(models.view(stored));
  assert.deepEqual(view.execution, stored);
  assert.equal(view.value, choiceOf(view, SONNET).value);
  assert.equal(view.effortLabel, 'Low');
  watch.dispose();
});

test('T6.3-3: a stored model no provider lists comes first in its provider group (T-30)', async () => {
  const { models } = await open(host());
  const watch = await watching(models);

  const view = ready(
    models.view({ providerId: 'openrouter', model: 'unlisted/model' }),
  );
  assert.equal(view.execution.model, 'unlisted/model');
  assert.equal(view.groups.length, 1);
  assert.deepEqual(
    view.groups[0]?.choices.map((choice) => choice.label),
    ['unlisted/model', SONNET, CODER, THINKER],
  );
  assert.equal(view.value, choiceOf(view, 'unlisted/model').value);
  watch.dispose();
});

test('T6.3-3: a stored model on a provider no longer configured is shown in a group of its own (T-30)', async () => {
  const { models } = await open(host());
  const watch = await watching(models);

  const view = ready(
    models.view({ providerId: 'gone', model: 'old/model', effort: 'low' }),
  );
  assert.equal(view.execution.providerId, 'gone');
  assert.equal(view.execution.model, 'old/model');
  assert.equal(view.groups.length, 2);
  const own = view.groups.find((group) =>
    group.choices.some((choice) => choice.label === 'old/model'),
  );
  assert.ok(own !== undefined, 'No group holds the stored model.');
  assert.deepEqual(
    own.choices.map((choice) => choice.label),
    ['old/model'],
  );
  assert.equal(view.value, choiceOf(view, 'old/model').value);
  watch.dispose();
});

test('T6.3-4: a Thread that stores nothing shows the default', async () => {
  const { models } = await open(host());
  const watch = await watching(models);

  const nothing = ready(models.view({}));
  assert.deepEqual(nothing.execution, DEFAULT);
  assert.deepEqual(nothing, ready(models.view()));
  watch.dispose();
});

/* ------------------------------------------------------------------ */
/* 5–6. what a pick yields                                             */
/* ------------------------------------------------------------------ */

test("T6.3-5: each model choice starts at that model's start effort, and the shown model's own choice keeps the shown effort (T-26)", async () => {
  const { models } = await open(host());
  const watch = await watching(models);

  const onSonnetLow = ready(
    models.view({ providerId: 'openrouter', model: SONNET, effort: 'low' }),
  );
  assert.deepEqual(choiceOf(onSonnetLow, SONNET).execution, {
    providerId: 'openrouter',
    model: SONNET,
    effort: 'low',
  });
  // A model that lists no effort runs without one.
  assert.deepEqual(choiceOf(onSonnetLow, CODER).execution, {
    providerId: 'openrouter',
    model: CODER,
  });
  // A model whose catalog names its own default starts there.
  assert.deepEqual(choiceOf(onSonnetLow, THINKER).execution, {
    providerId: 'openrouter',
    model: THINKER,
    effort: 'medium',
  });

  // SONNET names no default effort: from another model it starts at its first.
  const onCoder = ready(
    models.view({ providerId: 'openrouter', model: CODER }),
  );
  assert.deepEqual(choiceOf(onCoder, SONNET).execution, {
    providerId: 'openrouter',
    model: SONNET,
    effort: 'low',
  });
  // The default's own choice keeps the default's effort.
  assert.deepEqual(choiceOf(ready(models.view()), SONNET).execution, DEFAULT);
  watch.dispose();
});

test("T6.3-6: the efforts leave out none, mark the catalog's default, and each yields the shown model at that effort", async () => {
  const { models } = await open(host());
  const watch = await watching(models);

  const view = ready(
    models.view({ providerId: 'openrouter', model: THINKER, effort: 'high' }),
  );
  assert.deepEqual(
    view.efforts.map((effort) => [effort.label, effort.value, effort.note]),
    [
      ['Low', 'low', undefined],
      ['Medium', 'medium', '(default)'],
      ['High', 'high', undefined],
    ],
  );
  for (const effort of view.efforts) {
    assert.deepEqual(effort.execution, {
      providerId: 'openrouter',
      model: THINKER,
      effort: effort.value,
    });
  }
  assert.equal(view.effortLabel, 'High');

  const plain = ready(models.view());
  assert.ok(
    plain.efforts.every((effort) => effort.note === undefined),
    'An effort of a model with no catalog default is marked.',
  );
  watch.dispose();
});

test('T6.3-6: a model with no efforts offers none, labelled Unavailable', async () => {
  const { models } = await open(host());
  const watch = await watching(models);

  const view = ready(models.view({ providerId: 'openrouter', model: CODER }));
  assert.deepEqual(view.efforts, []);
  assert.equal(view.effortLabel, 'Unavailable');
  watch.dispose();
});

/* ------------------------------------------------------------------ */
/* 7. a model typed by hand                                            */
/* ------------------------------------------------------------------ */

test("T6.3-7: with no listed model the view asks for a typed model, on the shown provider when configured and else on the default's (T-33)", async () => {
  const { models } = await open(
    host(
      configurationOf([openrouter([]), lmstudio([])], {
        providerId: 'openrouter',
        model: 'm-1',
      }),
    ),
  );
  const watch = await watching(models);

  const byDefault = ready(models.view());
  assert.equal(byDefault.listsModels, false);
  assert.equal(byDefault.execution.model, 'm-1');
  assert.equal(byDefault.typedProviderId, 'openrouter');

  const onStudio = ready(models.view({ providerId: 'lmstudio', model: 'm-2' }));
  assert.equal(onStudio.listsModels, false);
  assert.equal(onStudio.typedProviderId, 'lmstudio');

  const onGone = ready(models.view({ providerId: 'gone', model: 'm-3' }));
  assert.equal(onGone.execution.model, 'm-3');
  assert.equal(onGone.typedProviderId, 'openrouter');

  assert.equal(ready(models.view()).listsModels, false);
  watch.dispose();
});

test('T6.3-7: a provider that lists a model makes the view a list', async () => {
  const { models } = await open(host());
  const watch = await watching(models);
  assert.equal(ready(models.view()).listsModels, true);
  watch.dispose();
});

/* ------------------------------------------------------------------ */
/* 8. icons                                                            */
/* ------------------------------------------------------------------ */

test('T6.3-8: no choice has an icon before the first icon answer, and after it the models and the shown one wear theirs', async () => {
  const icons = deferred<unknown>();
  let asked: unknown;
  const { models } = await open(
    host(undefined, {
      'models/v1.icons': (input: unknown) => {
        asked = input;
        return icons.promise;
      },
    }),
  );
  const watch = await watching(models);

  const before = ready(models.view());
  assert.equal(before.icon, undefined);
  assert.ok(
    choicesOf(before).every((choice) => choice.icon === undefined),
    'A choice wears an icon before the host answered any.',
  );

  icons.resolve(answerIcons(asked));
  await settle(20);

  const after = ready(models.view());
  assert.equal(after.icon, svgs.claude);
  assert.equal(choiceOf(after, SONNET).icon, svgs.claude);
  assert.equal(choiceOf(after, CODER).icon, undefined);
  assert.equal(
    ready(models.view({ providerId: 'openrouter', model: CODER })).icon,
    undefined,
  );
  watch.dispose();
});

test('T6.3-8: the previous icons stay while a later icon answer is pending', async () => {
  let configuration = configurationOf();
  const later = deferred<unknown>();
  let answered = 0;
  const { models } = await open(
    host(undefined, {
      'host-config/v1.current': () => snapshot(configuration),
      'models/v1.icons': (input: unknown) => {
        answered += 1;
        return answered === 1 ? answerIcons(input) : later.promise;
      },
    }),
  );
  const watch = await watching(models);
  assert.equal(choiceOf(ready(models.view()), SONNET).icon, svgs.claude);

  // The provider lists one more model: the icons are asked again.
  configuration = configurationOf([
    openrouter([...listed, { name: 'anthropic/claude-haiku', reasonings: [] }]),
  ]);
  models.reload();
  await settle(20);

  const pending = ready(models.view());
  assert.equal(choicesOf(pending).length, 4);
  assert.equal(choiceOf(pending, SONNET).icon, svgs.claude);
  assert.equal(pending.icon, svgs.claude);
  watch.dispose();
});

test('T6.3-8: a failed icon read gives no icons and no error', async () => {
  const { models } = await open(
    host(undefined, {
      'models/v1.icons': () => {
        throw new Error('The icons are unavailable.');
      },
    }),
  );
  const watch = await watching(models);

  const view = ready(models.view());
  assert.equal(view.error, undefined);
  assert.equal(view.icon, undefined);
  assert.ok(choicesOf(view).every((choice) => choice.icon === undefined));
  watch.dispose();
});

/* ------------------------------------------------------------------ */
/* 9–10. a failed read, reload, and no write                           */
/* ------------------------------------------------------------------ */

test('T6.3-9: a failed first read is a loading view with the error; reload reads the snapshot once, is reloading until it lands, then clears the error (T-23)', async () => {
  const second = deferred<unknown>();
  let calls = 0;
  const { window, models } = await open(
    host(undefined, {
      'host-config/v1.current': () => {
        calls += 1;
        if (calls === 1) throw new Error('The store is locked.');
        return second.promise;
      },
    }),
  );
  const watch = await watching(models);

  const failed = models.view();
  assert.equal(failed.status, 'loading');
  assert.equal(failed.reloading, false);
  assert.ok(failed.error !== undefined, 'The failed read gives no error.');
  // An `ErrorInfo`: plain data with its code and its causes.
  const info = failed.error as {
    readonly code?: unknown;
    readonly causes?: unknown;
  };
  assert.equal(typeof info.code, 'string');
  assert.ok(Array.isArray(info.causes), JSON.stringify(failed.error));

  const before = reads(window);
  models.reload();
  models.reload();
  await settle(20);
  assert.equal(reads(window) - before, 1, 'reload read other than once.');
  const busy = models.view();
  assert.equal(busy.status, 'loading');
  assert.equal(busy.reloading, true);
  assert.ok(busy.error !== undefined, 'The error left while its read runs.');

  second.resolve(snapshot(configurationOf()));
  await settle(20);
  const view = ready(models.view());
  assert.equal(view.error, undefined);
  assert.equal(view.reloading, false);
  assert.deepEqual(view.execution, DEFAULT);
  watch.dispose();
});

test('T6.3-9: reload reads the configuration snapshot only, not the draft another settings surface reads (T-23)', async () => {
  let failing = true;
  const { window, models } = await open(
    host(undefined, {
      'host-config/v1.current': () => {
        if (failing) throw new Error('The store is locked.');
        return snapshot(configurationOf());
      },
    }),
    // The dashboard's Providers group keeps the window's configuration draft
    // (`useConfig`) on the same host read.
    ['settings-dashboard-providers'],
  );
  const watch = await watching(models);
  assert.equal(models.view().status, 'loading');

  failing = false;
  const before = reads(window);
  models.reload();
  await settle(40);

  assert.equal(
    reads(window) - before,
    1,
    'reload read more than the snapshot.',
  );
  assert.equal(ready(models.view()).error, undefined);
  watch.dispose();
});

test('T6.3-9: a failed read after a success keeps the ready view beside the error', async () => {
  let failing = false;
  const { models } = await open(
    host(undefined, {
      'host-config/v1.current': () => {
        if (failing) throw new Error('The store is locked.');
        return snapshot(configurationOf());
      },
    }),
  );
  const watch = await watching(models);
  ready(models.view());

  failing = true;
  models.reload();
  await settle(20);

  const view = ready(models.view());
  assert.ok(view.error !== undefined, 'The failed re-read gives no error.');
  assert.deepEqual(view.execution, DEFAULT);
  assert.equal(view.reloading, false);
  watch.dispose();
});

test('T6.3-10: no view, focus or reload sends host-config/v1.replace, a default stored at effort none included (T-29)', async () => {
  const stored = configurationOf(
    [
      openrouter([
        { name: SONNET, reasonings: ['none', 'low', 'high'] },
        { name: CODER, reasonings: [] },
      ]),
    ],
    { providerId: 'openrouter', model: SONNET, effort: 'none' },
  );
  const { window, models } = await open(host(stored));
  const watch = await watching(models);

  const view = ready(models.view());
  assert.equal(view.execution.effort, 'none');
  assert.ok(view.efforts.every((effort) => effort.value !== 'none'));
  models.view({ providerId: 'openrouter', model: SONNET, effort: 'none' });
  models.view({});
  window.window.dispatchEvent(new window.window.Event('focus'));
  await settle(20);
  models.reload();
  await settle(800);

  assert.equal(window.received('host-config/v1.replace').length, 0);
  watch.dispose();
});

/* ------------------------------------------------------------------ */
/* 11–13. identity, memory, lifetime                                   */
/* ------------------------------------------------------------------ */

test('T6.3-11: view answers the same object for equal arguments until the configuration changes, then a new one, and every subscriber is called', async () => {
  let configuration = configurationOf();
  const { models } = await open(
    host(undefined, {
      'host-config/v1.current': () => snapshot(configuration),
    }),
  );
  const first = await watching(models);
  const second = await watching(models);

  const a = models.view({ providerId: 'openrouter', model: CODER });
  assert.equal(
    models.view({ providerId: 'openrouter', model: CODER }),
    a,
    'Equal arguments answered another object.',
  );
  assert.equal(
    models.view({ providerId: 'openrouter', model: CODER, effort: undefined }),
    a,
  );
  const byDefault = models.view();
  assert.equal(models.view(), byDefault);

  const heard = [first.calls(), second.calls()];
  configuration = configurationOf([openrouter()], {
    providerId: 'openrouter',
    model: CODER,
  });
  models.reload();
  await settle(20);

  const b = models.view({ providerId: 'openrouter', model: CODER });
  assert.notEqual(b, a, 'A new configuration answered the old view.');
  assert.deepEqual(ready(models.view()).execution, {
    providerId: 'openrouter',
    model: CODER,
  });
  assert.ok(
    first.calls() > (heard[0] ?? 0),
    'The first subscriber was not called.',
  );
  assert.ok(
    second.calls() > (heard[1] ?? 0),
    'The second subscriber was not called.',
  );
  first.dispose();
  second.dispose();
});

test('T6.3-12: a ninth distinct stored execution evicts the least recently read view, and reading it again answers a new object with equal content', async () => {
  const { models } = await open(host());
  const watch = await watching(models);
  const stored = (index: number): Stored => ({
    providerId: 'openrouter',
    model: `vendor/model-${index}`,
  });

  // Each view's icons land first, so nothing but the reads below changes it.
  for (let index = 1; index <= 8; index += 1) models.view(stored(index));
  await settle(20);
  const kept = new Map<number, View>();
  for (let index = 1; index <= 8; index += 1) {
    kept.set(index, models.view(stored(index)));
  }
  // Eight are kept: each answers the object it answered before.
  for (let index = 1; index <= 8; index += 1) {
    assert.equal(models.view(stored(index)), kept.get(index), `view ${index}`);
  }
  // Read 1 again: 2 is now the least recently read.
  assert.equal(models.view(stored(1)), kept.get(1));

  models.view(stored(9));
  assert.equal(
    models.view(stored(1)),
    kept.get(1),
    'A recent view was evicted.',
  );

  const again = models.view(stored(2));
  assert.notEqual(again, kept.get(2), 'The least recently read view was kept.');
  assert.deepEqual(again, kept.get(2));
  watch.dispose();
});

test('T6.3-13: a window focus reads the configuration again only while the service has a subscriber', async () => {
  const { window, models } = await open(host());
  const focus = async () => {
    window.window.dispatchEvent(new window.window.Event('focus'));
    await settle(20);
  };

  const idle = reads(window);
  await focus();
  assert.equal(reads(window), idle, 'A focus read with no subscriber.');

  const watch = await watching(models);
  const watched = reads(window);
  await focus();
  assert.equal(reads(window) - watched, 1, 'A focus did not read once.');

  watch.dispose();
  const after = reads(window);
  await focus();
  assert.equal(
    reads(window),
    after,
    'A focus read after the last subscriber left.',
  );
});

/* ------------------------------------------------------------------ */
/* 14–15. the shape and the manifest                                   */
/* ------------------------------------------------------------------ */

const keysWithin = (
  value: object,
  allowed: readonly string[],
  required: readonly string[],
  what: string,
): void => {
  const keys = Object.keys(value);
  for (const key of keys) {
    assert.ok(allowed.includes(key), `${what} carries a stray key, ${key}.`);
  }
  for (const key of required) {
    assert.ok(keys.includes(key), `${what} lacks ${key}.`);
  }
};

test('T6.3-14: a ready view carries exactly the keys of its type, and so do its groups, choices and efforts', async () => {
  const { models } = await open(host());
  const watch = await watching(models);

  const view = ready(
    models.view({ providerId: 'openrouter', model: THINKER, effort: 'low' }),
  );
  keysWithin(
    view,
    [
      'status',
      'error',
      'reloading',
      'execution',
      'icon',
      'value',
      'listsModels',
      'groups',
      'efforts',
      'effortLabel',
      'typedProviderId',
    ],
    [
      'status',
      'reloading',
      'execution',
      'value',
      'listsModels',
      'groups',
      'efforts',
      'effortLabel',
      'typedProviderId',
    ],
    'The view',
  );
  const executionKeys = ['providerId', 'model', 'effort'];
  keysWithin(
    view.execution,
    executionKeys,
    ['providerId', 'model'],
    'The execution',
  );
  for (const group of view.groups) {
    keysWithin(group, ['label', 'choices'], ['choices'], 'A group');
    for (const choice of group.choices) {
      keysWithin(
        choice,
        ['label', 'value', 'icon', 'execution'],
        ['label', 'value', 'execution'],
        'A choice',
      );
      keysWithin(
        choice.execution,
        executionKeys,
        ['providerId', 'model'],
        'A choice execution',
      );
    }
  }
  for (const effort of view.efforts) {
    keysWithin(
      effort,
      ['label', 'value', 'note', 'execution'],
      ['label', 'value', 'execution'],
      'An effort',
    );
  }
  watch.dispose();
});

test('T6.3-15, AC6.4: the settings manifest is 1.12.0, "The settings window.", provides settings.models/v1@1.0.0, requires no runtime.threads/v1 and asks for platform ^1.9.0', async () => {
  const manifest = JSON.parse(
    await readFile(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../manifest.json',
      ),
      'utf8',
    ),
  ) as {
    readonly version: string;
    readonly description: string;
    readonly provides: readonly string[];
    readonly requires: readonly string[];
    readonly optional?: readonly string[];
    readonly engines: { readonly doric: string };
  };

  assert.equal(manifest.version, '1.12.0');
  assert.equal(manifest.description, 'The settings window.');
  assert.ok(
    manifest.provides.includes('settings.models/v1@1.0.0'),
    `provides ${manifest.provides.join(', ')}`,
  );
  assert.ok(
    manifest.provides.includes('settings.config/v1@1.1.0'),
    `provides ${manifest.provides.join(', ')}`,
  );
  assert.ok(
    !manifest.requires.some((entry) => entry.startsWith('runtime.threads/v1@')),
    `requires ${manifest.requires.join(', ')}`,
  );
  // Bundle isolation 4(d): the dashboard is `workspace`'s; no optional line
  // names a contract of the layout.
  assert.ok(
    !(manifest.optional ?? []).some((id) => id.startsWith('layout.')),
    `optional ${(manifest.optional ?? []).join(', ')}`,
  );
  assert.equal(manifest.engines.doric, '^1.9.0');
});
