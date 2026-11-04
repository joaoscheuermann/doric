// The mark a sent turn wears in the gutter when comments open its block: the
// comment group above the reader's words wears it, and the words below wear
// none; a turn drawn before its comments arrive gives its mark to them.
//
// happy-dom draws no pseudo-element, so a block's mark is read the way the
// conversation's sheet decides it: the sheet (`src/client/styles.css`, the
// file the build ships) draws a mark in a block's `::before` or `::after` by
// a rule over `[data-turn-avatar]`, and a `content: none` rule takes it away.
// Each rule's selector, without its pseudo-element, is matched against the
// window's own elements, so the test holds whatever attribute or structure
// the sheet uses to decide.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { svgMask } from 'desktop/ui/svg-mask';

import {
  type AgentMarkIcon,
  applyTurnAvatar,
} from '../../src/client/components/organisms/conversation/nodes/turn-avatar.js';
import {
  type ChatWindow,
  type HostAnswer,
  type ModelsV1Version,
  openChatWindow,
  settle,
} from './support/window.js';

const here = dirname(fileURLToPath(import.meta.url));
const stylesheet = resolve(here, '../../../src/client/styles.css');

const projectId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const promptId = '33333333-3333-4333-8333-333333333333';
const url = `doric://app/projects/${projectId}/threads/${threadId}`;

const thread = () => ({
  id: threadId,
  name: 'Review the checkout',
  projectId,
  state: 'idle',
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const event = (
  sequence: number,
  value: Readonly<Record<string, unknown> & { readonly type: string }>,
) => ({
  projectId,
  threadId,
  promptId,
  sequence,
  type: value.type,
  event: value,
  createdAt: `2026-01-01T00:00:${String(sequence).padStart(2, '0')}.000Z`,
});

const prompt = event(1, {
  type: 'prompt.accepted',
  text: 'Ajusta o checkout',
  source: { kind: 'user' },
});

const commented = event(2, {
  type: 'comments.added/v1',
  commentId: 'comment-a',
  target: {
    kind: 'artifact',
    id: 'art_1',
    revision: 1,
    anchor: { form: 'point', x: 10, y: 20, label: 'Button' },
  },
  text: 'aumenta o botão',
  author: 'jao.scheuermann',
});

const finished = event(3, {
  type: 'prompt.finished',
  status: 'completed',
  text: 'Vou ajustar.',
});

/** The same comment, written to the log after the answer finished. */
const commentedLater = { ...commented, sequence: 4 };

let opened: ChatWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

/** Delivers the Thread's log, whole, as the watch's snapshot. */
const deliver = async (
  window: ChatWindow,
  events: readonly unknown[],
): Promise<void> => {
  window.watches().at(-1)?.push({
    kind: 'snapshot',
    threadId,
    projectId,
    project: null,
    thread: thread(),
    events,
  });
  await settle(200);
};

/** Opens the Thread and delivers its log. */
const open = async (
  events: readonly unknown[],
  models?: {
    readonly version: ModelsV1Version;
    readonly icons?: HostAnswer;
  },
): Promise<ChatWindow> => {
  opened = await openChatWindow({
    url,
    host: {
      'runtime.threads/v1.thread': () => thread(),
      'runtime.threads/v1.queue': () => ({
        revision: 1,
        paused: false,
        stopping: false,
        items: [],
      }),
      ...(models?.icons === undefined
        ? {}
        : { 'models/v1.icons': models.icons }),
    },
    ...(models === undefined ? {} : { modelsV1: models.version }),
  });
  await deliver(opened, events);
  return opened;
};

/** The sheet's rules over a block's pseudo-element: whom, and what they draw. */
interface MarkRule {
  /** The selector of the block, its pseudo-element taken off. */
  readonly block: string;
  /** Whether the rule draws something there (`content` other than `none`). */
  readonly draws: boolean;
  /** Whether the rule draws the turn's mark. */
  readonly mark: boolean;
}

/** Every rule of the sheet that sets `content` on a block of the editor. */
const markRules = async (): Promise<
  Readonly<Record<'::before' | '::after', readonly MarkRule[]>>
> => {
  const sheet = (await readFile(stylesheet, 'utf8')).replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const rules: Record<'::before' | '::after', MarkRule[]> = {
    '::before': [],
    '::after': [],
  };
  for (const match of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const content = /(?:^|;)\s*content\s*:\s*([^;]+)/
      .exec(match[2] ?? '')?.[1]
      ?.trim();
    if (content === undefined) continue;
    for (const part of (match[1] ?? '').split(',')) {
      const selector = part.replace(/\s+/g, ' ').trim();
      if (!selector.includes('[data-lexical-editor]')) continue;
      for (const pseudo of ['::before', '::after'] as const) {
        if (!selector.endsWith(pseudo)) continue;
        rules[pseudo].push({
          block: selector.slice(0, -pseudo.length),
          draws: content !== 'none',
          mark: selector.includes('[data-turn-avatar'),
        });
      }
    }
  }
  return rules;
};

/** Whether the sheet draws a turn's mark beside `element`. */
const wearsMark = async (element: Element): Promise<boolean> => {
  const rules = await markRules();
  const matches = (rule: MarkRule): boolean => {
    try {
      return element.matches(rule.block);
    } catch {
      return false;
    }
  };
  return (['::before', '::after'] as const).some((pseudo) => {
    const own = rules[pseudo].filter(matches);
    return (
      own.some((rule) => rule.draws && rule.mark) &&
      !own.some((rule) => !rule.draws)
    );
  });
};

/** The block of the reader's sent words. */
const words = (window: ChatWindow): Element => {
  const block = window.document.querySelector(
    `[data-lexical-editor] > [data-prompt-id="${promptId}"]`,
  );
  assert.ok(block, 'the sent turn is drawn');
  return block;
};

/** The comment group that opens the sent turn, if it draws one. */
const group = (window: ChatWindow): Element | null =>
  window.document.querySelector('[data-lexical-editor] > [data-turn-comments]');

test('a sent turn whose comments open its block wears its mark on them, not on its words', async () => {
  const window = await open([prompt, commented, finished]);

  const comments = group(window);
  assert.ok(comments, 'the comments open the turn');
  assert.equal(comments.nextElementSibling, words(window));
  assert.equal(await wearsMark(comments), true);
  assert.equal(await wearsMark(words(window)), false);
});

test('a sent turn without comments wears its own mark', async () => {
  const window = await open([prompt, finished]);

  assert.equal(group(window), null);
  assert.equal(await wearsMark(words(window)), true);
});

test('a turn drawn before its comments arrive gives its mark to them as they open it', async () => {
  const window = await open([prompt, finished]);
  const before = words(window);
  assert.equal(await wearsMark(before), true);

  window.watches().at(-1)?.push({ kind: 'event', event: commentedLater });
  await settle(200);

  const comments = group(window);
  assert.ok(comments, 'the comments open the turn');
  assert.equal(words(window), before, 'the words keep their block');
  assert.equal(await wearsMark(comments), true);
  assert.equal(await wearsMark(words(window)), false);
});

// The agent's mark is the icon of the model that answered the turn wearing it:
// the `response.started` before the run's first answer names it, and the
// window reads it from the host's `models/v1.icons`.

/** A model's icon, as the host answers it; its `id`s find any copy drawn as markup. */
const MODEL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" id="model-icon-fixture" viewBox="0 0 24 24"><path id="model-icon-fixture-path" d="M4 4h16v16H4z"/></svg>';

/** The run that answers the prompt: one response of `or`'s model `a`. */
const answered = [
  prompt,
  event(2, { type: 'prompt.started' }),
  event(3, { type: 'agent.started', model: 'a' }),
  event(4, { type: 'response.started', providerId: 'or', model: 'a' }),
  event(5, { type: 'text.delta', delta: 'Vou ajustar.' }),
  event(6, {
    type: 'prompt.finished',
    status: 'completed',
    text: 'Vou ajustar.',
  }),
];

/** The host's answer naming `MODEL_SVG` for the model asked. */
const iconAnswer = {
  svgs: { openrouter: MODEL_SVG },
  answers: [{ provider: 'openrouter', models: ['openrouter'] }],
};

/** The block that wears the agent's mark. */
const agentBlock = (window: ChatWindow): HTMLElement => {
  const blocks = window.document.querySelectorAll<HTMLElement>(
    '[data-lexical-editor] > [data-turn-avatar="agent"]',
  );
  assert.equal(blocks.length, 1, "one block wears the agent's mark");
  return blocks[0] as HTMLElement;
};

/** The icon an agent mark wears, as its block's custom property. */
const iconOf = (block: HTMLElement): string =>
  block.style.getPropertyValue('--turn-avatar-icon').trim();

/**
 * The icon an agent mark in `icon`'s state wears, read off a scratch block:
 * always a mask, the empty one included, so the box stays drawn.
 */
const iconIn = (window: ChatWindow, icon: AgentMarkIcon): string => {
  const scratch = window.document.createElement('div');
  applyTurnAvatar(scratch, { role: 'agent', name: 'agent', icon });
  const value = iconOf(scratch);
  assert.match(value, /^url\("data:image\/svg\+xml,/, `a ${icon.kind} mask`);
  return value;
};

test("the agent's mark is empty while its icon loads, then wears it without its turn changing", async () => {
  let release: (answer: unknown) => void = () => undefined;
  const held = new Promise((done) => {
    release = done;
  });
  const window = await open(answered, {
    version: '1.3.0',
    icons: () => held,
  });

  const block = agentBlock(window);
  const text = block.textContent;
  assert.equal(iconOf(block), iconIn(window, { kind: 'pending' }));

  release(iconAnswer);
  await settle(200);

  assert.equal(agentBlock(window), block, 'the turn keeps its block');
  assert.equal(block.textContent, text, 'the turn keeps its words');
  assert.equal(iconOf(block), svgMask(MODEL_SVG));
});

test("a failed icon read leaves the agent's mark empty, not the bot glyph", async () => {
  const window = await open(answered, {
    version: '1.3.0',
    icons: () => {
      throw { code: 'unavailable', message: 'Doric backend is unavailable.' };
    },
  });

  const icon = iconOf(agentBlock(window));
  assert.equal(icon, iconIn(window, { kind: 'pending' }));
  assert.notEqual(icon, iconIn(window, { kind: 'fallback' }));
});

test('a host without models/v1 icons draws the bot glyph', async () => {
  const window = await open(answered, { version: '1.2.0' });

  assert.equal(
    iconOf(agentBlock(window)),
    iconIn(window, { kind: 'fallback' }),
  );
});

test("the transcript holds no element of the icon's SVG", async () => {
  const window = await open(answered, {
    version: '1.3.0',
    icons: () => iconAnswer,
  });

  assert.equal(iconOf(agentBlock(window)), svgMask(MODEL_SVG));
  assert.equal(window.document.getElementById('model-icon-fixture'), null);
  assert.equal(window.document.getElementById('model-icon-fixture-path'), null);
});
