// The execution picker of the conversation footer as the reader meets it: the
// settings bundle defines `settings-execution-picker`, a `layout.footer` item.
// A probe bundle plays the layout's footer: it registers the route `/footer`,
// which mounts that element the way the layout's footer region does.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { NavigationV1, UiV1 } from 'bundle/contracts';

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

/** The layout's footer: the route `/footer` mounts the execution picker. */
const footerProbe: ProbeBundle = {
  requires: ['ui/v1@^1.0.0', 'navigation/v1@^1.0.0'],
  activate: (context) => {
    const route = context.services.use(NavigationV1).register({
      path: '/footer',
      create: () =>
        context.services
          .use(UiV1)
          .create('settings-execution-picker') as HTMLElement,
    });
    return () => route.dispose();
  },
};

let opened: SettingsWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

/** Opens the footer with the execution profile on `model`, icons answered. */
const openFooter = async (model: string): Promise<SettingsWindow> => {
  opened = await openSettingsWindow({
    url: 'doric://app/footer',
    host: host(model),
    probe: footerProbe,
  });
  await settle(20);
  await settle(20);
  return opened;
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
