// T6.4 (bundle isolation 6(c)): the execution picker of the conversation
// footer as the reader meets it, drawn by the chat. The chat defines
// `chat-execution-picker` and adds it to `shell.conversation.footer` while a
// provider of `settings.models/v1` is there. A probe bundle plays the other
// bundles: it provides a fake `settings.models/v1` that answers literal views
// per stored execution (the rules that compute them are `settings`' and are
// tested there, T6.3), and, unless a test says otherwise, a fake
// `workspace.selection/v1` whose selection the test sets. The window's
// `runtime.records/v1` holds the Thread records, and the host answers
// `runtime.threads/v1.setThreadExecution`.
//
// The 22 cases moved from `settings`' `tests/client/execution-picker.test.ts`
// keep their DOM assertions. What changed with the move (decision O5): what a
// case reads of the host's configuration is now what the fake view carries;
// "no replace" and "reads nothing else" are T6.3's; a read failure is counted
// in `reload` calls; the layout's record is the records mirror; a window
// without the layout's selection is one without workspace.selection/v1.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import {
  type ClientContext,
  type Disposable,
  defineMethod,
  defineService,
  disposableSchema,
  functionSchema,
  noInput,
  RegionsV1,
  UiV1,
} from 'bundle/contracts';
import type { RuntimeRecords, Thread } from 'runtime/contracts';
import { createRecordsApi } from 'runtime/testing';
import { z } from 'zod';

import { announced, noticesIn, retryOf, titleOf } from './support/notices.js';
import {
  type ChatWindow,
  type HostAnswer,
  openChatWindow,
  settle,
} from './support/window.js';

/* ------------------------------------------------------------------ */
/* The views the fake settings.models/v1 answers                       */
/* ------------------------------------------------------------------ */

const SONNET = 'anthropic/claude-sonnet-4';
const CODER = 'acme/coder-7b';

/**
 * The SVGs the views carry, each with a unique `id` that tells whether any of
 * its markup reached the document.
 */
const svgs = {
  claude:
    '<svg id="fixture-icon-claude" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z"/></svg>',
} as const;

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

type View = Readonly<Record<string, unknown>>;

/** What a stored execution answers: a view, computed once per distinct one. */
type World = (stored: Stored | undefined) => View;

const key = (providerId: string, model: string): string =>
  `${providerId}:${model}`;

const label = (effort: string): string =>
  effort.charAt(0).toUpperCase() + effort.slice(1);

/** OpenRouter's models as the views list them: SONNET with its icon, CODER without one. */
const catalog: readonly {
  readonly model: string;
  readonly icon?: string;
  readonly efforts: readonly string[];
}[] = [
  { model: SONNET, icon: svgs.claude, efforts: ['low', 'high'] },
  { model: CODER, efforts: [] },
];

/** A model picked from another starts at its first effort (neither names a default). */
const startOf = (model: string): Execution => {
  const first = catalog.find((entry) => entry.model === model)?.efforts[0];
  return {
    providerId: 'openrouter',
    model,
    ...(first === undefined ? {} : { effort: first }),
  };
};

/** The execution a stored one shows: itself when it names a model, else the default. */
const shownOf = (stored: Stored | undefined, fallback: Execution): Execution =>
  stored?.providerId !== undefined && stored.model !== undefined
    ? {
        providerId: stored.providerId,
        model: stored.model,
        ...(stored.effort === undefined ? {} : { effort: stored.effort }),
      }
    : fallback;

/** A ready view of `execution` over OpenRouter's two listed models. */
const listedView = (execution: Execution): View => {
  const onOpenRouter = execution.providerId === 'openrouter';
  const entry = onOpenRouter
    ? catalog.find((candidate) => candidate.model === execution.model)
    : undefined;
  const efforts = entry?.efforts ?? [];
  const listed = catalog.map((candidate) => ({
    label: candidate.model,
    value: key('openrouter', candidate.model),
    ...(candidate.icon === undefined ? {} : { icon: candidate.icon }),
    execution:
      onOpenRouter && candidate.model === execution.model
        ? execution
        : startOf(candidate.model),
  }));
  const own =
    entry === undefined
      ? [
          {
            label: execution.model,
            value: key(execution.providerId, execution.model),
            execution,
          },
        ]
      : [];
  return {
    status: 'ready',
    reloading: false,
    execution,
    ...(entry?.icon === undefined ? {} : { icon: entry.icon }),
    value: key(execution.providerId, execution.model),
    listsModels: true,
    groups: onOpenRouter
      ? [{ choices: [...own, ...listed] }]
      : [
          { label: execution.providerId, choices: own },
          { label: 'openrouter', choices: listed },
        ],
    efforts: efforts.map((effort) => ({
      label: label(effort),
      value: effort,
      execution: { ...execution, effort },
    })),
    effortLabel:
      efforts.length === 0 ? 'Unavailable' : label(execution.effort ?? 'none'),
    typedProviderId: 'openrouter',
  };
};

/** The workspace default on `model`, as the settings tests configured it. */
const defaultOn = (model: string): Execution =>
  model === SONNET
    ? { providerId: 'openrouter', model, effort: 'high' }
    : { providerId: 'openrouter', model };

/** Views over the listed models, the default on `fallback`. */
const listed =
  (fallback: Execution = defaultOn(SONNET)): World =>
  (stored) =>
    listedView(shownOf(stored, fallback));

/** Views where no provider lists a model: the model is typed, on OpenRouter. */
const typed =
  (fallback: Execution = { providerId: 'openrouter', model: 'm-1' }): World =>
  (stored) => {
    const execution = shownOf(stored, fallback);
    return {
      status: 'ready',
      reloading: false,
      execution,
      value: key(execution.providerId, execution.model),
      listsModels: false,
      groups: [],
      efforts: [],
      effortLabel: 'Unavailable',
      typedProviderId: 'openrouter',
    };
  };

/** The failure of a configuration read, as `settings` carries it in a view. */
const readFailure = {
  code: 'internal',
  message: 'The request could not be completed.',
  causes: [],
  at: '2026-01-01T00:00:00.000Z',
};

/** No configuration read yet; the last read failed with `readFailure`. */
const failed =
  (reloading = false): World =>
  () => ({ status: 'loading', error: readFailure, reloading });

/**
 * `settings.models/v1` as a fake provider: `view` answers what the world says
 * for the stored execution, the same object for equal fields until the world
 * changes; `set` changes it and calls the subscribers; `reload` is counted
 * and runs what the test asks.
 */
const settingsModels = (initial: World) => {
  let world = initial;
  let generation = 0;
  const views = new Map<string, View>();
  const listeners = new Set<() => void>();
  let reloads = 0;
  let onReload: () => void = () => undefined;

  const view = (stored: Stored | undefined): View => {
    const id = `${generation}|${JSON.stringify([
      stored?.providerId ?? null,
      stored?.model ?? null,
      stored?.effort ?? null,
    ])}`;
    const found = views.get(id);
    if (found !== undefined) return found;
    const made = world(stored);
    views.set(id, made);
    return made;
  };
  const set = (next: World): void => {
    world = next;
    generation += 1;
    views.clear();
    for (const listener of [...listeners]) listener();
  };

  const service = defineService('settings.models/v1', {
    view: defineMethod({
      input: z.tuple([z.unknown().optional()]),
      output: z.unknown(),
      execute: ([stored]: [unknown?]) => view(stored as Stored | undefined),
    }),
    subscribe: defineMethod({
      input: functionSchema<() => void>(),
      output: disposableSchema,
      execute: (listener: () => void): Disposable => {
        listeners.add(listener);
        return { dispose: () => void listeners.delete(listener) };
      },
    }),
    reload: defineMethod({
      input: noInput,
      output: z.void(),
      execute: () => {
        reloads += 1;
        onReload();
      },
    }),
  });

  return {
    service,
    set,
    reloads: (): number => reloads,
    /** What a `reload` call does from now on. */
    whenReloaded: (run: () => void): void => {
      onReload = run;
    },
  };
};

/* ------------------------------------------------------------------ */
/* The workspace: the selection and the Thread records                 */
/* ------------------------------------------------------------------ */

const PROJECT = 'p-1';
const CREATED = '2026-01-01T00:00:00.000Z';

/** A Thread storing `execution`; `{}` is a Thread created before 1.7.0. */
const thread = (id: string, execution: Stored, updatedAt = CREATED): Thread =>
  ({
    id,
    projectId: PROJECT,
    name: `Thread ${id}`,
    state: 'ready',
    lastSequence: 0,
    cwd: '/workspace',
    createdAt: CREATED,
    updatedAt,
    ...execution,
  }) as Thread;

/**
 * The workspace as the chat reads it: `workspace.selection/v1` (a fake whose
 * selection the test sets) and `runtime.records/v1` (the window's records,
 * whose Thread records the test publishes).
 */
const workspaceOf = (selected?: Thread) => {
  const records = new Map<string, Thread>();
  const recordListeners = new Set<() => void>();
  const selectionListeners = new Set<() => void>();
  if (selected !== undefined) records.set(selected.id, selected);
  let selection: { readonly projectId?: string; readonly threadId?: string } =
    selected === undefined ? {} : { projectId: PROJECT, threadId: selected.id };

  const notifyRecords = (): void => {
    for (const listener of [...recordListeners]) listener();
  };

  const recordsApi: RuntimeRecords = {
    ...createRecordsApi(),
    thread: (threadId) => {
      const record = records.get(threadId);
      return record === undefined ? undefined : structuredClone(record);
    },
    subscribe: (listener) => {
      const heard = () => listener();
      recordListeners.add(heard);
      return { dispose: () => void recordListeners.delete(heard) };
    },
  };

  const service = defineService('workspace.selection/v1', {
    current: defineMethod({
      input: noInput,
      output: z.unknown(),
      execute: () => selection,
    }),
    subscribe: defineMethod({
      input: functionSchema<() => void>(),
      output: disposableSchema,
      execute: (listener: () => void): Disposable => {
        selectionListeners.add(listener);
        return { dispose: () => void selectionListeners.delete(listener) };
      },
    }),
  });

  return {
    service,
    recordsApi,
    /** The reader selects `record` (or nothing) in the workspace. */
    select: (record: Thread | undefined): void => {
      if (record !== undefined) records.set(record.id, record);
      selection =
        record === undefined ? {} : { projectId: PROJECT, threadId: record.id };
      for (const listener of [...selectionListeners]) listener();
    },
    /** The records mirror publishes a Thread update it received from the host. */
    publish: (record: Thread): void => {
      records.set(record.id, record);
      notifyRecords();
    },
    /** A records notification that changes no record (another Thread's). */
    notify: notifyRecords,
  };
};

/* ------------------------------------------------------------------ */
/* The host's setThreadExecution                                       */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* The window                                                          */
/* ------------------------------------------------------------------ */

let opened: ChatWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

interface Footer {
  readonly window: ChatWindow;
  /** The items of `shell.conversation.footer`, as the shell would draw them. */
  readonly footerItems: () => readonly { readonly id: string }[];
}

/**
 * Opens a chat window and mounts `chat-execution-picker` as the shell's
 * footer region would. `models` and `workspace` are the probe's providers;
 * `null` leaves that contract out of the composition.
 */
const openWith = async (input: {
  readonly host?: Record<string, HostAnswer>;
  readonly models: ReturnType<typeof settingsModels> | null;
  readonly workspace: ReturnType<typeof workspaceOf> | null;
  readonly mount?: boolean;
}): Promise<Footer> => {
  let create: ((tag: string) => HTMLElement) | undefined;
  let items: Footer['footerItems'] = () => [];
  opened = await openChatWindow({
    url: 'doric://app/elsewhere',
    host: input.host ?? {},
    ...(input.workspace === null
      ? {}
      : { recordsApi: input.workspace.recordsApi }),
    probe: {
      provides: [
        ...(input.models === null ? [] : ['settings.models/v1']),
        ...(input.workspace === null ? [] : ['workspace.selection/v1']),
      ],
      requires: ['ui/v1@^1.0.0', 'regions/v1@^1.0.0'],
      activate: (context: ClientContext) => {
        if (input.models !== null)
          context.services.provide(input.models.service);
        if (input.workspace !== null) {
          context.services.provide(input.workspace.service);
        }
        const ui = context.services.use(UiV1);
        const regions = context.services.use(RegionsV1);
        create = (tag) => ui.create(tag) as HTMLElement;
        items = () => regions.items('shell.conversation.footer');
      },
    },
  });
  assert.ok(create, 'The probe did not activate.');
  if (input.mount !== false) {
    opened.document.body.append(create('chat-execution-picker'));
  }
  await settle(20);
  await settle(20);
  return { window: opened, footerItems: () => items() };
};

/**
 * Opens the footer with the workspace default on `model` and a selected
 * Thread that stores that same execution.
 */
const openFooter = async (model: string): Promise<ChatWindow> =>
  (
    await openWith({
      models: settingsModels(listed(defaultOn(model))),
      workspace: workspaceOf(thread('t-1', defaultOn(model))),
    })
  ).window;

/* ------------------------------------------------------------------ */
/* Reading the picker                                                  */
/* ------------------------------------------------------------------ */

/** What the disabled triggers tell the reader. */
const DEFAULT_TITLE =
  'New threads start on the workspace default. Change it in Settings.';

const trigger = (window: ChatWindow): HTMLElement => {
  const button = window.document.querySelector<HTMLElement>(
    'chat-execution-picker [aria-label="Execution model"]',
  );
  assert.ok(button !== null, 'The footer draws no execution model picker.');
  return button;
};

/** Opens the model popover from its trigger. */
const openPicker = async (window: ChatWindow): Promise<void> => {
  trigger(window).click();
  await settle(20);
};

/** The open popover's row that reads `label`. */
const rowOf = (window: ChatWindow, text: string): HTMLElement => {
  const row = [
    ...window.document.querySelectorAll<HTMLElement>(
      '[data-slot="popover-content"] button',
    ),
  ].find((button) => button.textContent?.trim() === text);
  assert.ok(row !== undefined, `The open picker has no row named ${text}.`);
  return row;
};

const iconIn = (element: HTMLElement): HTMLElement | null =>
  element.querySelector<HTMLElement>('[data-slot="model-icon"]');

const effortTrigger = (window: ChatWindow): HTMLElement => {
  const button = window.document.querySelector<HTMLElement>(
    'chat-execution-picker [aria-label="Reasoning effort"]',
  );
  assert.ok(button !== null, 'The footer draws no reasoning effort picker.');
  return button;
};

/** What the model trigger reads: its text, or the typed field's value. */
const shownModel = (window: ChatWindow): string => {
  const model = trigger(window);
  return model.tagName === 'INPUT'
    ? (model as HTMLInputElement).value
    : (model.textContent?.trim() ?? '');
};

const shownEffort = (window: ChatWindow): string =>
  effortTrigger(window).textContent?.trim() ?? '';

const isDisabled = (element: HTMLElement): boolean =>
  element.hasAttribute('disabled') ||
  element.getAttribute('aria-disabled') === 'true' ||
  element.hasAttribute('data-disabled');

const popoverOpen = (window: ChatWindow): boolean =>
  window.document.querySelector('[data-slot="popover-content"]') !== null;

/**
 * The failure notice the picker draws (error-messages.md §5.2): an inline,
 * announced notice, read as its title and whether it offers Retry;
 * `undefined` while the picker draws none.
 */
const alertOf = (
  window: ChatWindow,
):
  | {
      readonly title: string | undefined;
      readonly retry: HTMLButtonElement | null;
      readonly variant: string | null;
      readonly announced: boolean;
    }
  | undefined => {
  const notices = noticesIn(
    window.document.querySelector('chat-execution-picker'),
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
const alertText = async (window: ChatWindow): Promise<string | undefined> => {
  const notices = noticesIn(
    window.document.querySelector('chat-execution-picker'),
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
const sent = (window: ChatWindow): unknown[] =>
  window
    .received('runtime.threads/v1.setThreadExecution')
    .map((call) => JSON.parse(JSON.stringify(call.input)) as unknown);

/** Chooses the model row named `label` from the model popover. */
const chooseModel = async (window: ChatWindow, text: string): Promise<void> => {
  await openPicker(window);
  rowOf(window, text).click();
  await settle(20);
};

/** Chooses the effort named `label` from the effort trigger's popover. */
const chooseEffort = async (
  window: ChatWindow,
  text: string,
): Promise<void> => {
  effortTrigger(window).click();
  await settle(20);
  const row = [
    ...window.document.querySelectorAll<HTMLElement>(
      '[data-slot="popover-content"][aria-label="Reasoning effort"] button',
    ),
  ].find((button) => button.textContent?.trim().startsWith(text));
  assert.ok(row !== undefined, `The effort popover has no row named ${text}.`);
  row.click();
  await settle(20);
};

// `Event` and `KeyboardEvent` are the open window's: the harness installs its
// globals.
const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const pressEnter = (input: HTMLInputElement): void => {
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
  );
};

/* ------------------------------------------------------------------ */
/* Icons and look (moved)                                              */
/* ------------------------------------------------------------------ */

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

test("the trigger wears the shown model's icon before its name, and none when the view carries none", async () => {
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

test("the drawn icons hold no element of the view's SVG", async () => {
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

  assert.equal(window.document.getElementById('fixture-icon-claude'), null);
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
  const effort = effortTrigger(window);
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

test('a view that lists no models gets a typed model field with the input focus ring and a muted hover', async () => {
  // No listed models: nothing to pick, so the reader types the model id of
  // the selected Thread.
  const { window } = await openWith({
    models: settingsModels(typed({ providerId: 'openrouter', model: '' })),
    workspace: workspaceOf(
      thread('t-1', { providerId: 'openrouter', model: CODER }),
    ),
  });

  const field = trigger(window);
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

/* ------------------------------------------------------------------ */
/* What the picker shows and writes (moved)                            */
/* ------------------------------------------------------------------ */

/** The footer with nothing to edit: the default shown, both triggers locked. */
const assertDefaultLocked = async (window: ChatWindow): Promise<void> => {
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
};

test('with no Thread selected the footer shows the workspace default, locked and titled, and a click asks the host nothing (T-25)', async () => {
  const { window } = await openWith({
    host: { 'runtime.threads/v1.setThreadExecution': updated },
    models: settingsModels(listed()),
    workspace: workspaceOf(),
  });

  await assertDefaultLocked(window);
});

test('without workspace.selection/v1 the footer shows the workspace default, locked and titled, and a click asks the host nothing (T-39)', async () => {
  const { window } = await openWith({
    host: { 'runtime.threads/v1.setThreadExecution': updated },
    models: settingsModels(listed()),
    workspace: null,
  });

  await assertDefaultLocked(window);
});

test("a Thread's stored execution is shown, and choosing another model sets the Thread's execution at that model's start effort, never the default (T-26)", async () => {
  const { window } = await openWith({
    host: { 'runtime.threads/v1.setThreadExecution': updated },
    models: settingsModels(listed()),
    workspace: workspaceOf(
      thread('t-1', { providerId: 'openrouter', model: SONNET, effort: 'low' }),
    ),
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
});

test('choosing the model or the effort already shown asks the host nothing (T-27)', async () => {
  const { window } = await openWith({
    host: { 'runtime.threads/v1.setThreadExecution': updated },
    models: settingsModels(listed()),
    workspace: workspaceOf(
      thread('t-1', {
        providerId: 'openrouter',
        model: SONNET,
        effort: 'high',
      }),
    ),
  });

  await chooseModel(window, SONNET);
  await chooseEffort(window, 'High');

  assert.deepEqual(sent(window), []);
});

test('a Thread created before per-thread execution shows the default, and its first choice sends provider, model and effort (T-28)', async () => {
  const { window } = await openWith({
    host: { 'runtime.threads/v1.setThreadExecution': updated },
    models: settingsModels(listed()),
    workspace: workspaceOf(thread('t-1', {})),
  });

  assert.equal(shownModel(window), SONNET);
  assert.equal(shownEffort(window), 'High');

  await chooseEffort(window, 'Low');
  assert.deepEqual(sent(window), [
    { id: 't-1', providerId: 'openrouter', model: SONNET, effort: 'low' },
  ]);
});

test('a default stored at effort none is never written: mounting, focusing the window and selecting another Thread set no execution and read nothing again (T-29)', async () => {
  const models = settingsModels(
    listed({ providerId: 'openrouter', model: SONNET, effort: 'none' }),
  );
  const workspace = workspaceOf();
  const { window } = await openWith({
    host: { 'runtime.threads/v1.setThreadExecution': updated },
    models,
    workspace,
  });
  // The default is shown as stored, effort and all; nothing rewrites it.
  assert.equal(shownModel(window), SONNET);
  assert.equal(shownEffort(window), 'None');

  window.window.dispatchEvent(new window.window.Event('focus'));
  window.window.dispatchEvent(new window.window.Event('visibilitychange'));
  await settle(20);
  workspace.select(
    thread('t-2', { providerId: 'openrouter', model: SONNET, effort: 'none' }),
  );
  await settle(20);
  workspace.select(thread('t-3', {}));
  await settle(800);

  assert.equal(shownModel(window), SONNET);
  assert.deepEqual(sent(window), []);
  // A focus is `settings`' to read on (T6.3); the chat asks for no reload.
  assert.equal(models.reloads(), 0);
});

test('a Thread stored on a removed provider shows its stored model, and choosing a listed model sends it (T-30)', async () => {
  const { window } = await openWith({
    host: { 'runtime.threads/v1.setThreadExecution': updated },
    models: settingsModels(listed()),
    workspace: workspaceOf(
      thread('t-1', { providerId: 'gone', model: 'old/model', effort: 'low' }),
    ),
  });

  assert.equal(shownModel(window), 'old/model');

  await chooseModel(window, SONNET);
  assert.deepEqual(sent(window), [
    { id: 't-1', providerId: 'openrouter', model: SONNET, effort: 'low' },
  ]);
});

test('while a write is pending both triggers are disabled, and refused answers show their message in the picker notice (T-31)', async () => {
  const answers: ReturnType<typeof deferred<unknown>>[] = [];
  const { window } = await openWith({
    host: {
      'runtime.threads/v1.setThreadExecution': () => {
        const answer = deferred<unknown>();
        answers.push(answer);
        return answer.promise;
      },
    },
    models: settingsModels(listed()),
    workspace: workspaceOf(
      thread('t-1', { providerId: 'openrouter', model: CODER }),
    ),
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

test("a record update the records mirror publishes re-renders the Thread's execution (T-32)", async () => {
  const workspace = workspaceOf(
    thread('t-1', { providerId: 'openrouter', model: SONNET, effort: 'high' }),
  );
  const { window } = await openWith({
    models: settingsModels(listed()),
    workspace,
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

test('a typed model is sent once on blur and once on Enter, never per keystroke, and a blank or unchanged value sends nothing (T-33)', async () => {
  const { window } = await openWith({
    host: { 'runtime.threads/v1.setThreadExecution': updated },
    models: settingsModels(typed()),
    workspace: workspaceOf(
      thread('t-1', { providerId: 'openrouter', model: 'm-1' }),
    ),
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
});

test("on a Thread whose provider is no longer configured, a typed model is sent on the view's typed provider (T-33)", async () => {
  const { window } = await openWith({
    host: { 'runtime.threads/v1.setThreadExecution': updated },
    models: settingsModels(typed()),
    workspace: workspaceOf(thread('t-1', { providerId: 'gone', model: 'm-1' })),
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

test("an updated answer that arrives before the records mirror's record is shown, and the older record does not replace it (T-41)", async () => {
  const workspace = workspaceOf(
    thread('t-1', { providerId: 'openrouter', model: CODER }),
  );
  const { window } = await openWith({
    host: { 'runtime.threads/v1.setThreadExecution': updated },
    models: settingsModels(listed()),
    workspace,
  });

  await chooseModel(window, SONNET);
  assert.equal(shownModel(window), SONNET);

  // The mirror notifies before it has the update: its record is still older.
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
  const workspace = workspaceOf(a);
  const { window } = await openWith({
    host: { 'runtime.threads/v1.setThreadExecution': () => answer.promise },
    models: settingsModels(listed()),
    workspace,
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
// notice titled from the chat's catalog; Retry shows only where repeating the
// write can succeed, and writes the same execution again.

test('an invalid answer shows "Model not accepted" and a missing Thread "Thread not found", neither with Retry (T-23)', async () => {
  const answers = [
    { status: 'invalid', reason: 'effort' },
    { status: 'missing' },
  ];
  const { window } = await openWith({
    host: { 'runtime.threads/v1.setThreadExecution': () => answers.shift() },
    models: settingsModels(listed()),
    workspace: workspaceOf(
      thread('t-1', { providerId: 'openrouter', model: CODER }),
    ),
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
  const { window } = await openWith({
    host: {
      'runtime.threads/v1.setThreadExecution': (input: unknown) => {
        calls += 1;
        if (calls === 1) {
          throw { code: 'unavailable', message: 'The host is restarting.' };
        }
        return updated(input);
      },
    },
    models: settingsModels(listed()),
    workspace: workspaceOf(
      thread('t-1', { providerId: 'openrouter', model: CODER }),
    ),
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

test('a failed read shows an inline notice whose Retry reloads settings.models/v1, busy while it reads (T-23)', async () => {
  const models = settingsModels(failed());
  models.whenReloaded(() => models.set(failed(true)));
  const { window } = await openWith({
    models,
    workspace: workspaceOf(thread('t-1', {})),
  });

  const notice = alertOf(window);
  assert.equal(notice?.title, 'Settings not loaded');
  assert.equal(await alertText(window), 'The request could not be completed.');
  assert.equal(notice?.variant, 'inline');
  assert.equal(notice?.announced, true);
  assert.ok(notice?.retry, 'A failed read offers no Retry.');

  notice.retry.click();
  await settle(20);
  assert.equal(models.reloads(), 1);
  const busy = alertOf(window)?.retry;
  assert.ok(busy, 'The notice left while its read runs.');
  assert.equal(busy.getAttribute('aria-busy'), 'true');
  assert.equal(busy.disabled, true);

  models.set(listed());
  await settle(20);
  assert.equal(alertOf(window), undefined);
  assert.equal(shownModel(window), SONNET);
});

test("the read notice's Retry calls settings.models/v1.reload once and writes nothing (T-23)", async () => {
  const models = settingsModels(failed());
  models.whenReloaded(() => models.set(listed()));
  const { window } = await openWith({
    host: { 'runtime.threads/v1.setThreadExecution': updated },
    models,
    workspace: workspaceOf(thread('t-1', {})),
  });
  const retry = alertOf(window)?.retry;
  assert.ok(retry, 'The picker shows no read notice with Retry.');

  retry.click();
  await settle(40);

  assert.equal(models.reloads(), 1, 'Retry reloaded other than once.');
  assert.deepEqual(sent(window), []);
  assert.equal(alertOf(window), undefined);
});

/* ------------------------------------------------------------------ */
/* New with the move                                                   */
/* ------------------------------------------------------------------ */

test('T6.4-23, AC6.4: the chat manifest is 1.10.0 on platform ^1.10.0, names the picker, takes settings.models/v1 and workspace.selection/v1 as optional, no layout.* contract, and requires what it required', () => {
  const manifest = JSON.parse(
    readFileSync('bundles/desktop/chat/manifest.json', 'utf8'),
  ) as {
    readonly version: string;
    readonly description: string;
    readonly engines: { readonly doric: string };
    readonly requires: readonly string[];
    readonly optional: readonly string[];
  };

  assert.equal(manifest.version, '1.10.0');
  assert.equal(manifest.engines.doric, '^1.10.0');
  assert.equal(
    manifest.description,
    'The conversation: transcript, composer and the execution picker.',
  );
  assert.ok(manifest.optional.includes('settings.models/v1'));
  assert.ok(manifest.optional.includes('workspace.selection/v1'));
  // Bundle isolation 4(d): the Threads come from runtime.records/v1, so the
  // layout's transition line leaves.
  assert.deepEqual(
    manifest.optional.filter((id) => id.startsWith('layout.')),
    [],
  );
  assert.deepEqual(
    [...manifest.requires].sort(),
    [
      'hooks/v1@^1.0.0',
      'ui/v1@^1.0.0',
      'navigation/v1@^1.0.0',
      'regions/v1@^1.0.0',
      'commands/v1@^1.0.0',
      'menus/v1@^1.0.0',
      'runtime.threads/v1@^1.8.0',
      'runtime.attachments/v1@^1.0.0',
      'runtime.records/v1@^1.0.0',
      'comments/v1@^1.0.0',
      'chat.composer/v1@^1.0.0',
      'layout.tabs/v2@^2.0.0',
    ].sort(),
  );
});

test('T6.4-24: with a provider of settings.models/v1 the chat adds its picker to the conversation footer as the execution item at order 20', async () => {
  const { footerItems } = await openWith({
    models: settingsModels(listed()),
    workspace: workspaceOf(),
    mount: false,
  });

  const item = footerItems().find((entry) => entry.id === 'execution') as
    | Readonly<Record<string, unknown>>
    | undefined;
  assert.ok(item !== undefined, 'The footer holds no execution item.');
  assert.deepEqual(
    [item.tag, item.order, item.owner],
    ['chat-execution-picker', 20, 'chat'],
  );
});

test('T6.4-24: without a provider of settings.models/v1 the chat loads, the footer holds no execution item, and the picker draws nothing', async () => {
  const { window, footerItems } = await openWith({
    models: null,
    workspace: workspaceOf(
      thread('t-1', { providerId: 'openrouter', model: SONNET }),
    ),
  });

  // The chat is active: its own elements are defined, the picker's included.
  assert.ok(
    window.window.customElements.get('chat-thread-tab-icon') !== undefined,
    'The chat did not load without settings.models/v1.',
  );
  assert.ok(
    window.window.customElements.get('chat-execution-picker') !== undefined,
    'The chat defines no chat-execution-picker.',
  );
  assert.equal(
    footerItems().some((entry) => entry.id === 'execution'),
    false,
    'The footer holds an execution item without settings.models/v1.',
  );
  assert.equal(
    window.document.querySelector(
      'chat-execution-picker [aria-label="Execution model"]',
    ),
    null,
  );
  assert.equal(
    window.document.querySelector('chat-execution-picker')?.childElementCount ??
      0,
    0,
  );
});

test('T6.4-25, AC6.5: a pick writes the execution the view carries, as given: the chat applies no rule of its own', async () => {
  // Executions no rule of `settings` would yield here: SONNET at `max`, which
  // it does not list, and CODER at `minimal`, though it lists no effort.
  const madeUp: World = (stored) => {
    const view = listedView(shownOf(stored, defaultOn(SONNET)));
    const groups = view.groups as readonly {
      readonly label?: string;
      readonly choices: readonly Record<string, unknown>[];
    }[];
    return {
      ...view,
      groups: groups.map((group) => ({
        ...group,
        choices: group.choices.map((choice) =>
          choice.label === SONNET
            ? {
                ...choice,
                execution: {
                  providerId: 'openrouter',
                  model: SONNET,
                  effort: 'max',
                },
              }
            : choice.label === CODER
              ? {
                  ...choice,
                  execution: {
                    providerId: 'openrouter',
                    model: CODER,
                    effort: 'minimal',
                  },
                }
              : choice,
        ),
      })),
    };
  };
  const { window } = await openWith({
    host: { 'runtime.threads/v1.setThreadExecution': updated },
    models: settingsModels(madeUp),
    workspace: workspaceOf(
      thread('t-1', { providerId: 'openrouter', model: CODER }),
    ),
  });

  await chooseModel(window, SONNET);
  assert.deepEqual(sent(window), [
    { id: 't-1', providerId: 'openrouter', model: SONNET, effort: 'max' },
  ]);
});
