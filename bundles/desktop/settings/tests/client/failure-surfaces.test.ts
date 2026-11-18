// The settings failure surfaces of error-messages.md §5.2 that the section
// tests do not already cover, as the reader meets them in a settings window:
//
// - T-38: the provider model catalog shows a compact, announced notice whose
//   Retry replaces the Reload button and reads the catalog again; the catalog
//   models field of a kind whose models are its catalog shows the same notice.
//   (The execution picker's read failure is in `execution-picker.test.ts`,
//   the Claude sign-in toast in `claude-login.test.ts`, and the dashboard's
//   Providers group and open-site toast in `dashboard-providers.test.ts`.)
// - T-39: a refused configuration save or credential remove followed by a
//   successful one leaves one toast, the plain success, with no failure
//   notice; and no success or message toast in the chat, settings and layout
//   sources uses an id a `toastError` call uses.
//
// A host failure the test throws reaches the window as a contract error with
// code `internal`, which the notices skip for their surface's fallback code.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  announced,
  explanationOf,
  noticesIn,
  retryOf,
  type Toasts,
  titleOf,
  windowToasts,
} from './support/notices.js';
import {
  type HostAnswer,
  openSettingsWindow,
  type SettingsWindow,
  settle,
} from './support/window.js';

const token = '00000000-0000-4000-8000-000000000001';
const claudeToken = '00000000-0000-4000-8000-0000000000cc';

/** OpenRouter, whose `modelsUrl` field makes its models a catalog pick. */
const openrouter = {
  id: 'openrouter',
  label: 'OpenRouter',
  description: 'Hosted models.',
  fields: [
    { key: 'endpoint', label: 'Endpoint', kind: 'url', required: true },
    { key: 'token', label: 'Token', kind: 'secret', required: true },
    { key: 'modelsUrl', label: 'Models URL', kind: 'url', required: false },
  ],
  lists: ['models', 'reasonings'],
};

/** A kind whose models are its live catalog. */
const claude = {
  id: 'claude',
  label: 'Claude',
  description: 'Anthropic Messages through a Claude Code subscription login.',
  fields: [
    { key: 'endpoint', label: 'Endpoint', kind: 'url', required: false },
    { key: 'token', label: 'Token', kind: 'secret', required: true },
  ],
  lists: ['models', 'reasonings'],
  modelsFromCatalog: true,
};

const configuration = {
  providers: [
    {
      id: 'openrouter',
      kind: 'openrouter',
      configuration: { endpoint: 'https://openrouter.ai/api/v1', token },
      models: [{ name: 'deepseek/v4', reasonings: [] }],
    },
    {
      id: 'claude',
      kind: 'claude',
      configuration: {
        endpoint: 'https://api.anthropic.com',
        token: claudeToken,
      },
      models: [],
    },
  ],
  models: { execution: { providerId: 'openrouter', model: 'deepseek/v4' } },
  execution: { maxTurns: 32 },
};

const credentials = [
  { id: token, kind: 'API_TOKEN', name: 'OpenRouter', hasSecret: true },
  { id: claudeToken, kind: 'API_TOKEN', name: 'Claude', hasSecret: true },
];

/** One model as the catalog lists it. */
const listed = (id: string) => ({
  id,
  reasonings: [],
  parameters: [],
  mandatory: false,
});

/** A host with one stored configuration; a replace stores what it gets. */
const host = (): Record<string, HostAnswer> => {
  let revision = 1;
  let stored: unknown = configuration;
  return {
    'host-config/v1.current': () => ({
      configuration: stored,
      revision,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    'host-config/v1.replace': (input: unknown) => {
      revision += 1;
      stored = input;
      return {
        status: 'replaced',
        config: {
          configuration: input,
          revision,
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      };
    },
    'models/v1.kinds': () => [openrouter, claude],
    'models/v1.kind': (input: unknown) =>
      [openrouter, claude].find(
        (kind) => kind.id === (Array.isArray(input) ? input[0] : input),
      ),
    'secrets/v1.list': () => credentials,
    'tools/v1.catalog': () => [],
  };
};

let opened: SettingsWindow | undefined;
let toasts: Toasts | undefined;

afterEach(async () => {
  toasts?.dismissAll();
  toasts = undefined;
  await opened?.close();
  opened = undefined;
});

const open = async (
  path: string,
  answers: Readonly<Record<string, HostAnswer>> = {},
): Promise<{ window: SettingsWindow; toasts: Toasts }> => {
  opened = await openSettingsWindow({
    url: `doric://app${path}`,
    host: { ...host(), ...answers },
  });
  await settle(20);
  toasts = await windowToasts(opened.document);
  return { window: opened, toasts };
};

/** Opens the page of the provider row named `name`. */
const openProvider = async (
  window: SettingsWindow,
  name: string,
): Promise<void> => {
  const row = [
    ...window.document.querySelectorAll<HTMLElement>(
      '[data-slot="table-body"] [data-slot="table-row"]',
    ),
  ].find((candidate) => (candidate.textContent ?? '').includes(name));
  assert.ok(row !== undefined, `no provider row ${name}`);
  row.click();
  await settle(40);
};

const buttonsNamed = (root: ParentNode, label: string): HTMLButtonElement[] =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].filter(
    (button) => button.textContent?.trim() === label,
  );

const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};

/** A mouse press as a pointer delivers it: down, up, then the click. */
const press = (element: HTMLElement): void => {
  for (const name of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    element.dispatchEvent(
      new window.PointerEvent(name, { bubbles: true, pointerType: 'mouse' }),
    );
  }
  element.click();
};

/** The one notice inside the section card. */
const sectionNotice = (window: SettingsWindow): HTMLElement | undefined => {
  const notices = noticesIn(window.document.querySelector('main'));
  assert.ok(notices.length <= 1, 'the section draws more than one notice');
  return notices[0];
};

// T-38: the catalog rows of §5.2, one case each.

test('the provider model catalog shows a compact notice whose Retry replaces Reload and reads the catalog again (T-38)', async () => {
  let failing = true;
  let reads = 0;
  const { window } = await open('/settings/providers', {
    'models/v1.catalog': () => {
      reads += 1;
      return failing
        ? { status: 'failed' }
        : { status: 'read', models: [listed('qwen/qwen3-coder')] };
    },
  });
  await openProvider(window, 'openrouter');
  const picker = [...window.document.querySelectorAll('button')].find(
    (button) => button.textContent?.includes('1 offered'),
  );
  assert.ok(picker !== undefined, 'no models picker');
  picker.click();
  await settle(40);

  const notice = sectionNotice(window);
  assert.ok(notice, 'the failed catalog read draws no notice');
  assert.equal(titleOf(notice), 'Models not read');
  assert.equal(
    explanationOf(notice),
    'The provider model catalog could not be read.',
  );
  assert.equal(notice.getAttribute('data-variant'), 'compact');
  assert.equal(announced(notice), true);
  // The failed read's own Reload is gone; the picker's toolbar keeps its
  // Reload under the manual entry.
  assert.equal(
    buttonsNamed(window.document, 'Reload').length,
    1,
    'the failed read keeps its Reload beside the notice',
  );
  const retry = retryOf(notice);
  assert.ok(retry, 'the failed catalog read offers no Retry');

  failing = false;
  const before = reads;
  retry.click();
  await settle(60);

  assert.ok(reads > before, 'Retry did not read the catalog again');
  assert.equal(sectionNotice(window), undefined);
  assert.match(
    window.document.querySelector('main')?.textContent ?? '',
    /qwen\/qwen3-coder/,
  );
});

test('the catalog models field of a kind whose models are its catalog shows the compact notice, whose Retry reads again (T-38)', async () => {
  let failing = true;
  const { window } = await open('/settings/providers', {
    'models/v1.catalog': () =>
      failing
        ? { status: 'failed' }
        : { status: 'read', models: [listed('claude-opus-5-5')] },
  });
  await openProvider(window, 'claude');

  const notice = sectionNotice(window);
  assert.ok(notice, 'the failed catalog read draws no notice');
  assert.equal(titleOf(notice), 'Models not read');
  assert.equal(notice.getAttribute('data-variant'), 'compact');
  assert.equal(announced(notice), true);
  const retry = retryOf(notice);
  assert.ok(retry, 'the failed catalog read offers no Retry');

  failing = false;
  retry.click();
  await settle(60);
  assert.equal(sectionNotice(window), undefined);
  assert.match(
    window.document.querySelector('main')?.textContent ?? '',
    /claude-opus-5-5/,
  );
});

// T-39: a failure a later success supersedes leaves the success alone.

/**
 * Asserts the action's toast left is the plain success `text` under `id`:
 * its failure toast (`id` + `-failed`) is gone, and no failure notice is drawn.
 */
const assertPlainSuccess = async (
  toasts: Toasts,
  id: string,
  text: RegExp,
): Promise<void> => {
  // Let a dismissed toast finish leaving.
  await settle(500);
  assert.ok(toasts.ids().includes(id), `no ${id} toast`);
  assert.ok(!toasts.ids().includes(`${id}-failed`), `${id}-failed stays`);
  assert.deepEqual(toasts.surfaces(), [], 'a failure toast stays drawn');
  const success = toasts
    .drawn()
    .filter((toast) => text.test(toast.textContent ?? ''));
  assert.equal(success.length, 1, 'the success is not drawn once');
  assert.deepEqual(noticesIn(success[0]), [], 'the success draws a notice');
};

test('a refused save then a saved one leaves one toast, the plain "Settings saved." (T-39)', async () => {
  let refusing = true;
  const answers = host();
  const replace = answers['host-config/v1.replace'] as HostAnswer;
  const { window, toasts } = await open('/settings/execution', {
    'host-config/v1.replace': (input) =>
      refusing ? { status: 'rejected' } : replace(input),
  });
  const turns = window.document.getElementById(
    'execution-max-turns',
  ) as HTMLInputElement;

  type(turns, '12');
  await settle(700);
  assert.ok(toasts.ids().includes('config-save-failed'));

  refusing = false;
  type(turns, '13');
  await settle(700);

  await assertPlainSuccess(toasts, 'config-save', /Settings saved\./);
});

test('a refused credential remove then a removed one leaves one toast, the plain "Removed …" (T-39)', async () => {
  let refusing = true;
  const { window, toasts } = await open('/settings/credentials', {
    'secrets/v1.delete': () => (refusing ? 'referenced' : 'deleted'),
  });

  const remove = async (): Promise<void> => {
    const actions = window.document.querySelector<HTMLElement>(
      '[aria-label="Actions for OpenRouter"]',
    );
    assert.ok(actions !== null, 'no actions for OpenRouter');
    press(actions);
    await settle(20);
    const item = [
      ...window.document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((entry) => entry.textContent?.trim() === 'Delete');
    assert.ok(item !== undefined, 'the row offers no Delete');
    item.click();
    await settle(40);
  };

  await remove();
  assert.ok(toasts.ids().includes('credentials-write-failed'));

  refusing = false;
  await remove();

  await assertPlainSuccess(toasts, 'credentials-write', /Removed OpenRouter\./);
});

// T-39: the ids, read from the three bundles' sources.

const bundlesRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** Every `.ts` and `.tsx` file under `dir`. */
const sources = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
};

/** An id literal as written, with each `${…}` part read as `*`. */
const idPattern = /\bid:\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/;
const normalized = (id: string): string => id.replace(/\$\{[^}]*\}/g, '*');

/** The literal ids of the calls `call` matches, through the end of each call. */
const idsOf = (text: string, call: RegExp): string[] => {
  const ids: string[] = [];
  for (const match of text.matchAll(call)) {
    // The call's arguments, up to the statement's end.
    const rest = text.slice((match.index ?? 0) + match[0].length);
    const end = rest.search(/\)\s*;/);
    const args = end === -1 ? rest : rest.slice(0, end);
    const id = idPattern.exec(args)?.[2];
    if (id !== undefined) ids.push(normalized(id));
  }
  return ids;
};

test('no success or message toast in the chat, settings, layout and workspace sources uses an id a toastError call uses (T-39)', async () => {
  const failureIds = new Set<string>();
  const otherIds = new Set<string>();
  for (const bundle of ['chat', 'settings', 'layout', 'workspace']) {
    for (const file of await sources(join(bundlesRoot, bundle, 'src'))) {
      const text = await readFile(file, 'utf8');
      for (const id of idsOf(text, /\btoastError\(/g)) failureIds.add(id);
      for (const id of idsOf(text, /\btoast\.(?:success|message)\(/g)) {
        otherIds.add(id);
      }
    }
  }

  // The three settings actions that toast both outcomes (§4).
  for (const [failure, success] of [
    ['config-save-failed', 'config-save'],
    ['credentials-write-failed', 'credentials-write'],
    ['claude-login-failed', 'claude-login'],
  ]) {
    assert.ok(failureIds.has(failure), `no toastError uses ${failure}`);
    assert.ok(otherIds.has(success), `no success toast uses ${success}`);
  }
  const shared = [...otherIds].filter((id) => failureIds.has(id));
  assert.deepEqual(
    shared,
    [],
    'a success or message toast reuses a failure id',
  );
});
