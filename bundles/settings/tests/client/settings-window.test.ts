// The settings window as the user meets it: opened at `/settings`, the nav
// of five sections, each section a route, the search, and the save the
// window's close waits for.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  openSettingsWindow,
  type SettingsWindow,
  settle,
} from './support/window.js';

const token = '00000000-0000-4000-8000-000000000001';

const configuration = {
  providers: [
    {
      id: 'openrouter',
      kind: 'openrouter',
      configuration: { endpoint: 'https://openrouter.ai/api/v1', token },
      models: [{ name: 'deepseek/v4', reasonings: [] }],
    },
  ],
  models: { execution: { providerId: 'openrouter', model: 'deepseek/v4' } },
  execution: { maxTurns: 32 },
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

/** A host with one stored configuration; a replace stores what it gets. */
const host = () => {
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
    'models/v1.kinds': () => [openrouter],
    'secrets/v1.list': () => [],
    'tools/v1.catalog': () => [],
  };
};

let opened: SettingsWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

const heading = (window: SettingsWindow): string | undefined =>
  window.document.querySelector('h1')?.textContent ?? undefined;

const navRows = (window: SettingsWindow): string[] =>
  [...window.document.querySelectorAll('[data-sidebar="menu-button"]')].map(
    (row) => row.textContent ?? '',
  );

const activeRow = (window: SettingsWindow): string | undefined =>
  window.document.querySelector(
    '[data-sidebar="menu-button"][data-active="true"]',
  )?.textContent ?? undefined;

const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};

test('a window opened at /settings shows the Providers section and names itself', async () => {
  opened = await openSettingsWindow({ host: host() });
  await settle(20);

  assert.equal(opened.window.location.pathname, '/settings/providers');
  assert.equal(opened.document.title, 'Doric Settings');
  assert.equal(heading(opened), 'Providers');
  assert.deepEqual(navRows(opened), [
    'Providers',
    'Execution',
    'Tools',
    'Versioning',
    'Credentials',
  ]);
  assert.equal(activeRow(opened), 'Providers');
});

test('a nav row opens its section at its own path', async () => {
  opened = await openSettingsWindow({ host: host() });
  await settle(20);

  const tools = [
    ...opened.document.querySelectorAll('[data-sidebar="menu-button"]'),
  ].find((row) => row.textContent === 'Tools') as HTMLElement;
  tools.click();
  await settle(20);

  assert.equal(opened.window.location.pathname, '/settings/tools');
  assert.equal(heading(opened), 'Tools');
  assert.equal(activeRow(opened), 'Tools');
});

test('the search keeps the sections whose label or sentence matches', async () => {
  opened = await openSettingsWindow({ host: host() });
  await settle(20);

  const search = opened.document.querySelector(
    'input[aria-label="Search settings sections"]',
  ) as HTMLInputElement;

  type(search, 'turns');
  await settle();
  assert.deepEqual(navRows(opened), ['Execution']);
  // The section on screen stays, with no active row while the query lasts.
  assert.equal(heading(opened), 'Providers');

  type(search, 'nothing like this');
  await settle();
  assert.deepEqual(navRows(opened), []);
  assert.match(opened.document.body.textContent ?? '', /No sections match/);
});

test('closing the window within the debounce saves the pending change', async () => {
  opened = await openSettingsWindow({
    url: 'doric://app/settings/execution',
    host: host(),
  });
  await settle(20);

  const turns = opened.document.getElementById(
    'execution-max-turns',
  ) as HTMLInputElement;
  type(turns, '12');
  await settle();
  assert.equal(opened.received('host-config/v1.replace').length, 0);

  await opened.requestClose({ phase: 'close', forced: false, deadline: 0 });
  await opened.requestClose({
    phase: 'flush',
    forced: false,
    deadline: Date.now() + 1_500,
  });

  const saves = opened.received('host-config/v1.replace');
  assert.equal(saves.length, 1);
  const sent = saves[0]?.input as
    | { readonly execution: { readonly maxTurns: number } }
    | undefined;
  assert.equal(sent?.execution.maxTurns, 12);
});
