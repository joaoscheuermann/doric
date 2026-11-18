// The execution picker of the conversation footer as the reader meets it: the
// settings bundle defines `settings-execution-picker`, a `shell.conversation.footer` item.
// A probe bundle plays the layout's footer: it registers the route `/footer`,
// which mounts that element the way the layout's footer region does, and,
// unless a test says otherwise, provides `layout.workspace/v1` with a
// selection the test sets and a change notification the test sends.
// The picker edits the selected Thread's execution through
// `runtime.threads/v1.setThreadExecution`; it never writes the workspace
// default (`host-config/v1.replace`).

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  type AnyMethodDefinition,
  type Disposable,
  defineMethod,
  defineService,
  NavigationV1,
  UiV1,
} from 'bundle/contracts';
import { LayoutWorkspaceV1, layoutWorkspaceMethods } from 'workspace/contracts';

import { announced, noticesIn, retryOf, titleOf } from './support/notices.js';
import {
  type HostAnswer,
  openSettingsWindow,
  type ProbeBundle,
  type SettingsWindow,
  settle,
} from './support/window.js';

/** The stored credential the OpenRouter provider names. */
const openrouterToken = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'API_TOKEN',
  name: 'OpenRouter',
  hasSecret: true,
};

const openrouter = {
  id: 'openrouter',
  label: 'OpenRouter',
  description: 'Hosted models.',
  fields: [
    { key: 'endpoint', label: 'Endpoint', kind: 'url', required: true },
    { key: 'token', label: 'Token', kind: 'secret', required: true },
  ],
  lists: ['models', 'reasonings'],
};

const SONNET = 'anthropic/claude-sonnet-4';
const CODER = 'acme/coder-7b';

/**
 * The SVGs the host answers, each with a unique `id` that tells whether any
 * of its markup reached the document.
 */
const svgs: Readonly<Record<string, string>> = {
  claude:
    '<svg id="fixture-icon-claude" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>',
  openrouter:
    '<svg id="fixture-icon-openrouter" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>',
};

type IconsInput = {
  readonly requests: readonly {
    readonly kind: string;
    readonly models: readonly string[];
  }[];
};

/**
 * `models/v1.icons` as the host answers it, request by request: OpenRouter's
 * own icon for the provider, Claude for an `anthropic/` model, and none for
 * any other model.
 */
const answerIcons = (input: unknown) => {
  const { requests } = input as IconsInput;
  const answers = requests.map((request) => ({
    ...(request.kind === 'openrouter' ? { provider: 'openrouter' } : {}),
    models: request.models.map((model) =>
      model.startsWith('anthropic/') ? 'claude' : null,
    ),
  }));
  const used = new Set(
    answers.flatMap((answer) => [
      ...('provider' in answer ? [answer.provider] : []),
      ...answer.models.filter((name) => name !== null),
    ]),
  );
  return {
    svgs: Object.fromEntries(
      Object.entries(svgs).filter(([name]) => used.has(name)),
    ),
    answers,
  };
};

/** OpenRouter with two models, the execution profile on `model`. */
const configurationOn = (model: string) => ({
  providers: [
    {
      id: 'openrouter',
      kind: 'openrouter',
      configuration: {
        endpoint: 'https://openrouter.ai/api/v1',
        token: openrouterToken.id,
      },
      models: [
        { name: SONNET, reasonings: ['low', 'high'] },
        { name: CODER, reasonings: [] },
      ],
    },
  ],
  models: {
    execution: {
      providerId: 'openrouter',
      model,
      ...(model === SONNET ? { effort: 'high' } : {}),
    },
  },
  execution: { maxTurns: 32 },
});

const host = (model: string): Record<string, HostAnswer> => ({
  'host-config/v1.current': () => ({
    configuration: configurationOn(model),
    revision: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }),
  'models/v1.kinds': () => [openrouter],
  'models/v1.icons': answerIcons,
  'secrets/v1.list': () => [openrouterToken],
  'tools/v1.catalog': () => [],
});

/** What the disabled triggers tell the reader. */
const DEFAULT_TITLE =
  'New threads start on the workspace default. Change it in Settings.';

const CREATED = '2026-01-01T00:00:00.000Z';

/** A Thread record as `layout.workspace/v1` hands it out. */
type ThreadRecord = {
  readonly id: string;
  readonly updatedAt: string;
  readonly providerId?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly [key: string]: unknown;
};

/** A Thread storing `execution`; `{}` is a Thread created before 1.7.0. */
const thread = (
  id: string,
  execution: {
    readonly providerId?: string;
    readonly model?: string;
    readonly effort?: string;
  },
  updatedAt = CREATED,
): ThreadRecord => ({
  id,
  projectId: 'p-1',
  name: `Thread ${id}`,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: CREATED,
  updatedAt,
  ...execution,
});

/** The layout's footer: the route `/footer` mounts the execution picker. */
const mountFooter: ProbeBundle['activate'] = (context) => {
  const route = context.services.use(NavigationV1).register({
    path: '/footer',
    create: () =>
      context.services
        .use(UiV1)
        .create('settings-execution-picker') as HTMLElement,
  });
  return () => route.dispose();
};

/** The footer of a layout that provides no `layout.workspace/v1`. */
const footerProbe: ProbeBundle = {
  requires: ['ui/v1@^1.0.0', 'navigation/v1@^1.0.0'],
  activate: mountFooter,
};

/**
 * The workspace window's footer: `layout.workspace/v1` at 1.1.0 with the
 * method schemas the layout declares, over Thread records and a selection the
 * test controls. Every read answers a fresh copy, as the layout's does.
 */
const workspaceFooter = (selected?: ThreadRecord) => {
  const records = new Map<string, ThreadRecord>();
  const listeners = new Set<() => void>();
  let selectedId = selected?.id;
  if (selected !== undefined) records.set(selected.id, selected);

  const copy = (id: string | undefined): ThreadRecord | undefined => {
    const record = id === undefined ? undefined : records.get(id);
    return record === undefined ? undefined : structuredClone(record);
  };
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const handlers: Readonly<Record<string, (input: never) => unknown>> = {
    thread: (id: string) => copy(id),
    selectedThread: () => copy(selectedId),
    selection: () => {
      const record = copy(selectedId);
      return record === undefined ? {} : { thread: record };
    },
    threads: () => [...records.values()].map((record) => copy(record.id)),
    connected: () => true,
    setBottomVisible: () => undefined,
    subscribe: (listener: () => void): Disposable => {
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
  };

  const probe: ProbeBundle = {
    requires: ['ui/v1@^1.0.0', 'navigation/v1@^1.0.0'],
    provides: ['layout.workspace/v1@1.1.0'],
    activate: (context) => {
      context.services.provide(
        defineService(
          LayoutWorkspaceV1.id,
          Object.fromEntries(
            Object.entries(layoutWorkspaceMethods).map(([name, spec]) => [
              name,
              defineMethod({
                input: spec.input,
                output: spec.output,
                execute: (input: unknown) =>
                  (handlers[name] as (input: unknown) => never)(input),
              }) as AnyMethodDefinition,
            ]),
          ),
        ),
      );
      return mountFooter(context);
    },
  };

  return {
    probe,
    /** The reader selects `record` (or nothing) in the workspace. */
    select: (record: ThreadRecord | undefined): void => {
      if (record !== undefined) records.set(record.id, record);
      selectedId = record?.id;
      notify();
    },
    /** The layout publishes a Thread update it received from the host. */
    publish: (record: ThreadRecord): void => {
      records.set(record.id, record);
      notify();
    },
    /** A change notification that changes no record (another Thread's). */
    notify,
  };
};

/** A promise the test settles by hand: a host answer still in flight. */
const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

type ExecutionInput = {
  readonly id: string;
  readonly providerId: string;
  readonly model: string;
  readonly effort?: string;
};

let stamp = 0;

/**
 * `runtime.threads/v1.setThreadExecution` as the host answers an accepted
 * execution: the Thread's record, stored as asked and touched later.
 */
const updated = (input: unknown) => {
  const { id, providerId, model, effort } = input as ExecutionInput;
  stamp += 1;
  return {
    status: 'updated',
    thread: thread(
      id,
      { providerId, model, ...(effort === undefined ? {} : { effort }) },
      `2026-01-02T00:00:${String(stamp % 60).padStart(2, '0')}.000Z`,
    ),
  };
};

let opened: SettingsWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

/** Opens the footer at `/footer`, as a window part mounts it. */
const openWith = async (input: {
  readonly host: Record<string, HostAnswer>;
  readonly probe: ProbeBundle;
}): Promise<SettingsWindow> => {
  opened = await openSettingsWindow({
    url: 'doric://app/footer',
    host: input.host,
    probe: input.probe,
  });
  await settle(20);
  await settle(20);
  return opened;
};

/**
 * Opens the footer with the workspace default on `model` and a selected
 * Thread that stores that same execution, icons answered.
 */
const openFooter = async (model: string): Promise<SettingsWindow> => {
  const { execution } = configurationOn(model).models;
  return openWith({
    host: host(model),
    probe: workspaceFooter(thread('t-1', execution)).probe,
  });
};

const trigger = (window: SettingsWindow): HTMLElement => {
  const button = window.document.querySelector<HTMLElement>(
    'settings-execution-picker [aria-label="Execution model"]',
  );
  assert.ok(button !== null, 'The footer draws no execution model picker.');
  return button;
};

/** Opens the model popover from its trigger. */
const openPicker = async (window: SettingsWindow): Promise<void> => {
  trigger(window).click();
  await settle(20);
};

/** The open popover's row that reads `label`. */
const rowOf = (window: SettingsWindow, label: string): HTMLElement => {
  const row = [
    ...window.document.querySelectorAll<HTMLElement>(
      '[data-slot="popover-content"] button',
    ),
  ].find((button) => button.textContent?.trim() === label);
  assert.ok(row !== undefined, `The open picker has no row named ${label}.`);
  return row;
};

const iconIn = (element: HTMLElement): HTMLElement | null =>
  element.querySelector<HTMLElement>('[data-slot="model-icon"]');

const effortTrigger = (window: SettingsWindow): HTMLElement => {
  const button = window.document.querySelector<HTMLElement>(
    'settings-execution-picker [aria-label="Reasoning effort"]',
  );
  assert.ok(button !== null, 'The footer draws no reasoning effort picker.');
  return button;
};

/** What the model trigger reads: its text, or the typed field's value. */
const shownModel = (window: SettingsWindow): string => {
  const model = trigger(window);
  return model.tagName === 'INPUT'
    ? (model as HTMLInputElement).value
    : (model.textContent?.trim() ?? '');
};

const shownEffort = (window: SettingsWindow): string =>
  effortTrigger(window).textContent?.trim() ?? '';

const isDisabled = (element: HTMLElement): boolean =>
  element.hasAttribute('disabled') ||
  element.getAttribute('aria-disabled') === 'true' ||
  element.hasAttribute('data-disabled');

const popoverOpen = (window: SettingsWindow): boolean =>
  window.document.querySelector('[data-slot="popover-content"]') !== null;

/**
 * The failure notice the picker draws (error-messages.md §5.2): an inline,
 * announced notice, read as its title and whether it offers
 * Retry; `undefined` while the picker draws none.
 */
const alertOf = (
  window: SettingsWindow,
):
  | {
      readonly title: string | undefined;
      readonly retry: HTMLButtonElement | null;
      readonly variant: string | null;
      readonly announced: boolean;
    }
  | undefined => {
  const notices = noticesIn(
    window.document.querySelector('settings-execution-picker'),
  );
  assert.ok(notices.length <= 1, 'The picker draws more than one notice.');
  const notice = notices[0];
  return notice === undefined
    ? undefined
    : {
        title: titleOf(notice),
        retry: retryOf(notice),
        variant: notice.getAttribute('data-variant'),
        announced: announced(notice),
      };
};

/**
 * The picker notice's explanation, or `undefined` when none is shown. An
 * inline notice draws row 1 only (error-messages.md §3.3), so the explanation
 * is read from the copy text its Copy details writes (§3.4): the title, then
 * the explanation. The clipboard is the window's, stubbed for the read.
 */
const alertText = async (
  window: SettingsWindow,
): Promise<string | undefined> => {
  const notices = noticesIn(
    window.document.querySelector('settings-execution-picker'),
  );
  const notice = notices[0];
  if (notice === undefined) return undefined;
  const button = notice.querySelector<HTMLButtonElement>(
    // "Copied" while an earlier copy still reports its outcome.
    'button[aria-label="Copy details"], button[aria-label="Copied"]',
  );
  assert.ok(button, 'The picker notice offers no Copy details.');
  const nav = globalThis.navigator as Navigator & { clipboard?: unknown };
  const before = Object.getOwnPropertyDescriptor(nav, 'clipboard');
  let written: string | undefined;
  Object.defineProperty(nav, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string): Promise<void> => {
        written = text;
        return Promise.resolve();
      },
    },
  });
  try {
    button.click();
    await settle(10);
  } finally {
    if (before === undefined) {
      delete (nav as { clipboard?: unknown }).clipboard;
    } else {
      Object.defineProperty(nav, 'clipboard', before);
    }
  }
  assert.ok(written !== undefined, 'Copy details wrote nothing.');
  return written.split('\n')[1];
};

/**
 * The executions the picker asked the host to set, as they crossed the
 * bridge (an absent effort is no key at all).
 */
const sent = (window: SettingsWindow): unknown[] =>
  window
    .received('runtime.threads/v1.setThreadExecution')
    .map((call) => JSON.parse(JSON.stringify(call.input)) as unknown);

const replaced = (window: SettingsWindow): number =>
  window.received('host-config/v1.replace').length;

/** Chooses the model row named `label` from the model popover. */
const chooseModel = async (
  window: SettingsWindow,
  label: string,
): Promise<void> => {
  await openPicker(window);
  rowOf(window, label).click();
  await settle(20);
};

/** Chooses the effort named `label` from the effort trigger's popover. */
const chooseEffort = async (
  window: SettingsWindow,
  label: string,
): Promise<void> => {
  effortTrigger(window).click();
  await settle(20);
  const row = [
    ...window.document.querySelectorAll<HTMLElement>(
      '[data-slot="popover-content"][aria-label="Reasoning effort"] button',
    ),
  ].find((button) => button.textContent?.trim().startsWith(label));
  assert.ok(row !== undefined, `The effort popover has no row named ${label}.`);
  row.click();
  await settle(20);
};

const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};

const pressEnter = (input: HTMLInputElement): void => {
  input.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
  );
};

test('every model row of the open picker draws an icon slot, empty for a model without an icon, and the effort rows none', async () => {
  const window = await openFooter(SONNET);
  await openPicker(window);

  const sonnet = iconIn(rowOf(window, SONNET));
  assert.ok(sonnet !== null, `${SONNET} draws no icon slot.`);
  assert.match(sonnet.style.mask, /data:image\/svg\+xml/);

  const coder = iconIn(rowOf(window, CODER));
  assert.ok(coder !== null, `${CODER} draws no icon slot.`);
  assert.equal(coder.style.mask, '');

  // The reasoning row the model popover ends with opens the effort rows.
  const reasoning = window.document.querySelector<HTMLElement>(
    '[data-slot="popover-content"] [aria-label^="Reasoning effort, "]',
  );
  assert.ok(reasoning !== null, 'The open picker offers no reasoning row.');
  reasoning.click();
  await settle(20);

  const efforts = [
    ...window.document.querySelectorAll<HTMLElement>(
      '[data-slot="popover-content"][aria-label="Reasoning effort"] button',
    ),
  ];
  assert.deepEqual(
    efforts.map((row) => row.textContent?.trim()),
    ['Low', 'High'],
  );
  for (const row of efforts) {
    assert.equal(iconIn(row), null, `${row.textContent} draws an icon slot.`);
  }
});

test("the trigger wears the selected model's icon before its name, and none when the host answers none", async () => {
  const withIcon = trigger(await openFooter(SONNET));
  const icon = iconIn(withIcon);
  assert.ok(icon !== null, 'The trigger wears no icon for the model.');
  assert.match(icon.style.mask, /data:image\/svg\+xml/);
  const name = [...withIcon.querySelectorAll('span')].find(
    (span) => span.textContent?.trim() === SONNET,
  );
  assert.ok(name !== undefined, 'The trigger does not read the model name.');
  assert.ok(
    icon.compareDocumentPosition(name) & 4, // Node.DOCUMENT_POSITION_FOLLOWING
    'The icon is not drawn before the model name.',
  );

  await opened?.close();
  opened = undefined;

  const withoutIcon = trigger(await openFooter(CODER));
  assert.equal(withoutIcon.textContent?.trim(), CODER);
  assert.equal(iconIn(withoutIcon), null);
});

test("the drawn icons hold no element of the host's SVG", async () => {
  const window = await openFooter(SONNET);
  await openPicker(window);

  // The icons are drawn, so their absence from the document means something.
  assert.match(
    iconIn(rowOf(window, SONNET))?.style.mask ?? '',
    /data:image\/svg\+xml/,
  );
  assert.match(
    iconIn(trigger(window))?.style.mask ?? '',
    /data:image\/svg\+xml/,
  );

  for (const name of Object.keys(svgs)) {
    assert.equal(window.document.getElementById(`fixture-icon-${name}`), null);
  }
});

test('the picker anchors the footer at its left and draws its triggers as ghost `sm` buttons', async () => {
  const window = await openFooter(SONNET);

  // Figma `99:8035`: the picker is the footer's first item and pushes the
  // rest right (the picker's own root carries `mr-auto`).
  const model = trigger(window);
  const picker = model.parentElement;
  assert.ok(picker !== null, 'the picker root');
  const rootClasses = [...picker.classList];
  for (const name of ['mr-auto', 'gap-1'])
    assert.ok(
      rootClasses.includes(name),
      `${name} in ${rootClasses.join(' ')}`,
    );

  // Figma `31:15450`: the model and effort are the plain ghost `sm` button,
  // 28 px tall with its own padding, radius, hover, open and focus states; the
  // model trigger keeps 8 px from its icon to its name and a truncating width.
  const effort = window.document.querySelector<HTMLElement>(
    'settings-execution-picker [aria-label="Reasoning effort"]',
  );
  assert.ok(effort !== null, 'the effort trigger');
  for (const button of [model, effort]) {
    const classes = [...button.classList];
    for (const name of [
      'h-7',
      'px-2.5',
      'rounded-[min(var(--radius-md),12px)]',
      'focus-visible:ring-3',
      'hover:bg-muted',
      'aria-expanded:bg-muted',
    ])
      assert.ok(classes.includes(name), `${name} in ${classes.join(' ')}`);
    const overrides = classes.filter(
      (name) =>
        name === 'h-5' ||
        name === 'px-0' ||
        /:p[lr]-0$/.test(name) ||
        name.startsWith('after:'),
    );
    assert.deepEqual(overrides, [], `overrides in ${classes.join(' ')}`);
  }
  const modelClasses = [...model.classList];
  for (const name of [
    'has-data-[icon=inline-start]:pl-1.5',
    'gap-2',
    'max-w-72',
    'min-w-0',
  ])
    assert.ok(
      modelClasses.includes(name),
      `${name} in ${modelClasses.join(' ')}`,
    );
});

test('a provider that lists no models gets a typed model field with the input focus ring and a muted hover', async () => {
  // No listed models: nothing to pick, so the reader types the model id of
  // the selected Thread.
  const configuration = configurationOn('');
  opened = await openWith({
    host: {
      ...host(''),
      'host-config/v1.current': () => ({
        configuration: {
          ...configuration,
          providers: configuration.providers.map((provider) => ({
            ...provider,
            models: [],
          })),
        },
        revision: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    },
    probe: workspaceFooter(
      thread('t-1', { providerId: 'openrouter', model: CODER }),
    ).probe,
  });

  const field = trigger(opened);
  assert.equal(field.tagName, 'INPUT');
  const classes = [...field.classList];
  for (const name of [
    'focus-visible:border-ring',
    'focus-visible:ring-3',
    'focus-visible:ring-ring/50',
    'hover:bg-muted',
    'dark:hover:bg-muted/50',
    'h-8',
    'w-48',
  ])
    assert.ok(classes.includes(name), `${name} in ${classes.join(' ')}`);
  for (const name of [
    'focus-visible:ring-0',
    'focus-visible:border-transparent',
  ])
    assert.ok(!classes.includes(name), `${name} in ${classes.join(' ')}`);
});

/** The footer with nothing to edit: the default shown, both triggers locked. */
const assertDefaultLocked = async (window: SettingsWindow): Promise<void> => {
  assert.equal(shownModel(window), SONNET);
  assert.equal(shownEffort(window), 'High');
  for (const button of [trigger(window), effortTrigger(window)]) {
    assert.ok(
      isDisabled(button),
      `${button.getAttribute('aria-label')} is not disabled.`,
    );
    assert.equal(button.getAttribute('title'), DEFAULT_TITLE);
  }

  trigger(window).click();
  await settle(20);
  effortTrigger(window).click();
  await settle(20);
  assert.equal(popoverOpen(window), false, 'A disabled trigger opened.');
  assert.deepEqual(sent(window), []);
  assert.equal(replaced(window), 0);
};

test('with no Thread selected the footer shows the workspace default, locked and titled, and a click asks the host nothing (T-25)', async () => {
  const window = await openWith({
    host: host(SONNET),
    probe: workspaceFooter().probe,
  });

  await assertDefaultLocked(window);
});

test('without layout.workspace/v1 the footer shows the workspace default, locked and titled, and a click asks the host nothing (T-39)', async () => {
  const window = await openWith({ host: host(SONNET), probe: footerProbe });

  await assertDefaultLocked(window);
});

test("a Thread's stored execution is shown, and choosing another model sets the Thread's execution at that model's start effort, never the default (T-26)", async () => {
  const workspace = workspaceFooter(
    thread('t-1', { providerId: 'openrouter', model: SONNET, effort: 'low' }),
  );
  const window = await openWith({
    host: {
      ...host(SONNET),
      'runtime.threads/v1.setThreadExecution': updated,
    },
    probe: workspace.probe,
  });

  // The Thread's own effort, not the default's `high`.
  assert.equal(shownModel(window), SONNET);
  assert.equal(shownEffort(window), 'Low');
  assert.ok(!isDisabled(trigger(window)), 'The model trigger is disabled.');

  // CODER lists no effort, so none is sent.
  await chooseModel(window, CODER);
  assert.deepEqual(sent(window), [
    { id: 't-1', providerId: 'openrouter', model: CODER },
  ]);
  assert.equal(shownModel(window), CODER);

  // SONNET names no default effort: it starts at its first, `low`.
  await chooseModel(window, SONNET);
  assert.deepEqual(sent(window).at(-1), {
    id: 't-1',
    providerId: 'openrouter',
    model: SONNET,
    effort: 'low',
  });
  assert.equal(replaced(window), 0);
});

test('choosing the model or the effort already shown asks the host nothing (T-27)', async () => {
  const window = await openWith({
    host: {
      ...host(SONNET),
      'runtime.threads/v1.setThreadExecution': updated,
    },
    probe: workspaceFooter(
      thread('t-1', {
        providerId: 'openrouter',
        model: SONNET,
        effort: 'high',
      }),
    ).probe,
  });

  await chooseModel(window, SONNET);
  await chooseEffort(window, 'High');

  assert.deepEqual(sent(window), []);
  assert.equal(replaced(window), 0);
});

test('a Thread created before per-thread execution shows the default, and its first choice sends provider, model and effort (T-28)', async () => {
  const window = await openWith({
    host: {
      ...host(SONNET),
      'runtime.threads/v1.setThreadExecution': updated,
    },
    probe: workspaceFooter(thread('t-1', {})).probe,
  });

  assert.equal(shownModel(window), SONNET);
  assert.equal(shownEffort(window), 'High');

  await chooseEffort(window, 'Low');
  assert.deepEqual(sent(window), [
    { id: 't-1', providerId: 'openrouter', model: SONNET, effort: 'low' },
  ]);
});

test('a default stored at effort none is never rewritten: mounting, focusing the window and selecting another Thread send no replace (T-29)', async () => {
  const configuration = configurationOn(SONNET);
  const stored = {
    ...configuration,
    providers: configuration.providers.map((provider) => ({
      ...provider,
      models: [
        { name: SONNET, reasonings: ['none', 'low', 'high'] },
        { name: CODER, reasonings: [] },
      ],
    })),
    models: {
      execution: { providerId: 'openrouter', model: SONNET, effort: 'none' },
    },
  };
  const workspace = workspaceFooter();
  const window = await openWith({
    host: {
      ...host(SONNET),
      'host-config/v1.current': () => ({
        configuration: stored,
        revision: 1,
        updatedAt: CREATED,
      }),
      'host-config/v1.replace': () => {
        throw new Error('The footer wrote the workspace default.');
      },
    },
    probe: workspace.probe,
  });

  window.window.dispatchEvent(new window.window.Event('focus'));
  window.window.dispatchEvent(new window.window.Event('visibilitychange'));
  await settle(20);
  workspace.select(
    thread('t-2', { providerId: 'openrouter', model: SONNET, effort: 'none' }),
  );
  await settle(20);
  workspace.select(thread('t-3', {}));
  await settle(800);

  assert.equal(replaced(window), 0);
  assert.deepEqual(sent(window), []);
});

test('a Thread stored on a removed provider shows its stored model, and choosing a listed model sends it (T-30)', async () => {
  const window = await openWith({
    host: {
      ...host(SONNET),
      'runtime.threads/v1.setThreadExecution': updated,
    },
    probe: workspaceFooter(
      thread('t-1', { providerId: 'gone', model: 'old/model', effort: 'low' }),
    ).probe,
  });

  assert.equal(shownModel(window), 'old/model');

  await chooseModel(window, SONNET);
  assert.deepEqual(sent(window), [
    { id: 't-1', providerId: 'openrouter', model: SONNET, effort: 'low' },
  ]);
});

test('while a write is pending both triggers are disabled, and refused answers show their message in the picker notice (T-31)', async () => {
  const answers: ReturnType<typeof deferred<unknown>>[] = [];
  const window = await openWith({
    host: {
      ...host(SONNET),
      'runtime.threads/v1.setThreadExecution': () => {
        const answer = deferred<unknown>();
        answers.push(answer);
        return answer.promise;
      },
    },
    probe: workspaceFooter(
      thread('t-1', { providerId: 'openrouter', model: CODER }),
    ).probe,
  });

  await chooseModel(window, SONNET);
  assert.equal(sent(window).length, 1);
  // The execution being written is shown while it is in flight.
  assert.equal(shownModel(window), SONNET);
  assert.ok(isDisabled(trigger(window)), 'The model trigger is enabled.');
  assert.ok(
    isDisabled(effortTrigger(window)),
    'The effort trigger is enabled.',
  );

  answers[0]?.resolve({ status: 'invalid', reason: 'effort' });
  await settle(20);
  assert.equal(alertOf(window)?.title, 'Model not accepted');
  assert.equal(
    await alertText(window),
    'This model does not support that effort.',
  );
  assert.ok(!isDisabled(trigger(window)), 'The model trigger stays disabled.');
  assert.equal(shownModel(window), CODER);

  await chooseModel(window, SONNET);
  answers[1]?.resolve({
    status: 'unresolvable',
    message: 'The provider could not be reached.',
  });
  await settle(20);
  assert.equal(alertOf(window)?.title, 'Model not accepted');
  assert.equal(await alertText(window), 'The provider could not be reached.');
});

test("a record update the layout publishes re-renders the Thread's execution (T-32)", async () => {
  const workspace = workspaceFooter(
    thread('t-1', { providerId: 'openrouter', model: SONNET, effort: 'high' }),
  );
  const window = await openWith({
    host: host(SONNET),
    probe: workspace.probe,
  });
  assert.equal(shownModel(window), SONNET);

  workspace.publish(
    thread(
      't-1',
      { providerId: 'openrouter', model: CODER },
      '2026-01-03T00:00:00.000Z',
    ),
  );
  await settle(20);

  assert.equal(shownModel(window), CODER);
  assert.equal(shownEffort(window), 'Unavailable');
});

/** A host whose providers list no models: the model is typed by hand. */
const unlistedHost = (): Record<string, HostAnswer> => {
  const configuration = configurationOn('m-1');
  return {
    ...host('m-1'),
    'host-config/v1.current': () => ({
      configuration: {
        ...configuration,
        providers: configuration.providers.map((provider) => ({
          ...provider,
          models: [],
        })),
      },
      revision: 1,
      updatedAt: CREATED,
    }),
    'runtime.threads/v1.setThreadExecution': updated,
  };
};

test('a typed model is sent once on blur and once on Enter, never per keystroke, and a blank or unchanged value sends nothing (T-33)', async () => {
  const window = await openWith({
    host: unlistedHost(),
    probe: workspaceFooter(
      thread('t-1', { providerId: 'openrouter', model: 'm-1' }),
    ).probe,
  });
  const field = (): HTMLInputElement => trigger(window) as HTMLInputElement;

  field().focus();
  for (const value of ['m', 'm-', 'm-2']) {
    type(field(), value);
    await settle();
  }
  assert.deepEqual(sent(window), []);
  field().blur();
  await settle(20);
  assert.deepEqual(sent(window), [
    { id: 't-1', providerId: 'openrouter', model: 'm-2' },
  ]);

  field().focus();
  type(field(), '  m-3  ');
  pressEnter(field());
  await settle(20);
  assert.deepEqual(sent(window).at(-1), {
    id: 't-1',
    providerId: 'openrouter',
    model: 'm-3',
  });
  assert.equal(sent(window).length, 2);

  type(field(), '   ');
  field().blur();
  await settle(20);
  field().focus();
  // The model the Thread now runs on.
  type(field(), 'm-3');
  pressEnter(field());
  await settle(20);
  assert.equal(sent(window).length, 2);
  assert.equal(replaced(window), 0);
});

test("on a Thread whose provider is no longer configured, a typed model is sent on the default's provider (T-33)", async () => {
  const window = await openWith({
    host: unlistedHost(),
    probe: workspaceFooter(thread('t-1', { providerId: 'gone', model: 'm-1' }))
      .probe,
  });
  const field = trigger(window) as HTMLInputElement;

  field.focus();
  type(field, 'm-9');
  field.blur();
  await settle(20);

  assert.deepEqual(sent(window), [
    { id: 't-1', providerId: 'openrouter', model: 'm-9' },
  ]);
});

test("an updated answer that arrives before the layout's record is shown, and the layout's older record does not replace it (T-41)", async () => {
  const workspace = workspaceFooter(
    thread('t-1', { providerId: 'openrouter', model: CODER }),
  );
  const window = await openWith({
    host: {
      ...host(SONNET),
      'runtime.threads/v1.setThreadExecution': updated,
    },
    probe: workspace.probe,
  });

  await chooseModel(window, SONNET);
  assert.equal(shownModel(window), SONNET);

  // The layout notifies before it has the update: its record is still older.
  workspace.notify();
  await settle(20);
  assert.equal(shownModel(window), SONNET);
  assert.equal(shownEffort(window), 'Low');
});

test('a write in flight on one Thread never changes what another Thread shows, and its refusal is shown on its own Thread only (T-41)', async () => {
  const a = thread('t-a', { providerId: 'openrouter', model: CODER });
  const b = thread('t-b', {
    providerId: 'openrouter',
    model: SONNET,
    effort: 'high',
  });
  const answer = deferred<unknown>();
  const workspace = workspaceFooter(a);
  const window = await openWith({
    host: {
      ...host(SONNET),
      'runtime.threads/v1.setThreadExecution': () => answer.promise,
    },
    probe: workspace.probe,
  });

  await chooseModel(window, SONNET);
  assert.ok(isDisabled(trigger(window)), 'A is not locked while written.');

  workspace.select(b);
  await settle(20);
  assert.equal(shownModel(window), SONNET);
  assert.equal(shownEffort(window), 'High');
  assert.ok(!isDisabled(trigger(window)), "B's model trigger is disabled.");
  assert.ok(
    !isDisabled(effortTrigger(window)),
    "B's effort trigger is disabled.",
  );

  answer.resolve({ status: 'invalid', reason: 'effort' });
  await settle(20);
  assert.equal(await alertText(window), undefined);
  assert.equal(shownModel(window), SONNET);

  workspace.select(a);
  await settle(20);
  assert.equal(
    await alertText(window),
    'This model does not support that effort.',
  );
  assert.equal(shownModel(window), CODER);
});

// T-23 (error-messages.md §5.2): a refused write is an inline, announced
// notice titled from the settings catalog; Retry shows only where repeating
// the write can succeed, and writes the same execution again.

test('an invalid answer shows "Model not accepted" and a missing Thread "Thread not found", neither with Retry (T-23)', async () => {
  const answers = [
    { status: 'invalid', reason: 'effort' },
    { status: 'missing' },
  ];
  const window = await openWith({
    host: {
      ...host(SONNET),
      'runtime.threads/v1.setThreadExecution': () => answers.shift(),
    },
    probe: workspaceFooter(
      thread('t-1', { providerId: 'openrouter', model: CODER }),
    ).probe,
  });

  await chooseModel(window, SONNET);
  const invalid = alertOf(window);
  assert.equal(invalid?.title, 'Model not accepted');
  assert.equal(
    await alertText(window),
    'This model does not support that effort.',
  );
  assert.equal(invalid?.retry, null, 'An invalid execution offers Retry.');
  assert.equal(invalid?.variant, 'inline');
  assert.equal(invalid?.announced, true);

  await chooseModel(window, SONNET);
  const missing = alertOf(window);
  assert.equal(missing?.title, 'Thread not found');
  assert.equal(await alertText(window), 'The thread was not found.');
  assert.equal(missing?.retry, null, 'A missing Thread offers Retry.');
});

test('an unavailable host offers Retry, which writes the same execution again (T-23)', async () => {
  let calls = 0;
  const window = await openWith({
    host: {
      ...host(SONNET),
      'runtime.threads/v1.setThreadExecution': (input: unknown) => {
        calls += 1;
        if (calls === 1) {
          throw { code: 'unavailable', message: 'The host is restarting.' };
        }
        return updated(input);
      },
    },
    probe: workspaceFooter(
      thread('t-1', { providerId: 'openrouter', model: CODER }),
    ).probe,
  });

  await chooseModel(window, SONNET);
  const refused = alertOf(window);
  assert.equal(refused?.title, 'Doric host unavailable');
  assert.ok(refused?.retry, 'An unavailable host offers no Retry.');

  refused.retry.click();
  await settle(20);

  // The same execution, written twice: the refused one and its Retry.
  assert.equal(sent(window).length, 2);
  assert.deepEqual(sent(window)[1], sent(window)[0]);
  assert.equal((sent(window)[0] as ExecutionInput).model, SONNET);
  assert.equal(alertOf(window), undefined);
  assert.equal(shownModel(window), SONNET);
});

test('a failed read shows an inline notice whose Retry reads the snapshot again, busy while it reads (T-23)', async () => {
  const second = deferred<unknown>();
  let reads = 0;
  const window = await openWith({
    host: {
      ...host(SONNET),
      'host-config/v1.current': () => {
        reads += 1;
        if (reads === 1) throw new Error('The store is locked.');
        return second.promise;
      },
    },
    probe: workspaceFooter(thread('t-1', {})).probe,
  });

  const failed = alertOf(window);
  assert.equal(failed?.title, 'Settings not loaded');
  assert.equal(await alertText(window), 'The request could not be completed.');
  assert.equal(failed?.variant, 'inline');
  assert.equal(failed?.announced, true);
  assert.ok(failed?.retry, 'A failed read offers no Retry.');

  failed.retry.click();
  await settle(20);
  assert.equal(reads, 2);
  const busy = alertOf(window)?.retry;
  assert.ok(busy, 'The notice left while its read runs.');
  assert.equal(busy.getAttribute('aria-busy'), 'true');
  assert.equal(busy.disabled, true);

  second.resolve({
    configuration: configurationOn(SONNET),
    revision: 1,
    updatedAt: CREATED,
  });
  await settle(20);
  assert.equal(alertOf(window), undefined);
  assert.equal(shownModel(window), SONNET);
});

test("the read notice's Retry reads the picker's snapshot only, not the draft another surface reads (T-23)", async () => {
  let failing = true;
  let reads = 0;
  // The footer beside the dashboard's Providers group, which keeps the
  // window's configuration draft (`useConfig`) on the same host read.
  const probe: ProbeBundle = {
    requires: ['ui/v1@^1.0.0', 'navigation/v1@^1.0.0'],
    activate: (context) => {
      const ui = context.services.use(UiV1);
      const route = context.services.use(NavigationV1).register({
        path: '/footer',
        create: () => {
          const root = document.createElement('div');
          root.append(
            ui.create('settings-dashboard-providers') as HTMLElement,
            ui.create('settings-execution-picker') as HTMLElement,
          );
          return root;
        },
      });
      return () => route.dispose();
    },
  };
  const window = await openWith({
    host: {
      ...host(SONNET),
      'host-config/v1.current': () => {
        reads += 1;
        if (failing) throw new Error('The store is locked.');
        return {
          configuration: configurationOn(SONNET),
          revision: 1,
          updatedAt: CREATED,
        };
      },
    },
    probe,
  });
  const retry = alertOf(window)?.retry;
  assert.ok(retry, 'The picker shows no read notice with Retry.');

  failing = false;
  const before = reads;
  retry.click();
  await settle(40);

  assert.equal(reads - before, 1, 'Retry read more than the snapshot.');
  assert.equal(alertOf(window), undefined);
});
