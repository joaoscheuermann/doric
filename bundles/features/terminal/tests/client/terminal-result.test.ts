// The `terminal-result` element (bundle isolation 5(b), change 4): a
// background terminal's answer, the prompt the host enqueues when the command
// settles, drawn as its own block (the command, how it exited and the
// streams) instead of the Markdown the host framed it in. Moved from the
// chat's `nodes/terminal-result-node.tsx` and registered through
// `chat.views/v1` 1.2.0 as the input renderer of the source `terminal`.
// - AC5.3: the block's cases, moved from the chat's
//   `tests/client/terminal-result.test.ts`, mount the element alone with the
//   `view` the chat sets for the prompt (no chat window, no chat built part)
//   and select it by its `data-slot="terminal-result"`, not by the chat's
//   `data-terminal-id`.
// - `terminalResultOpenness` (moved from the chat's `tests/collapsible.test.ts`):
//   folded when the command finished cleanly, open when it did not; the
//   reader's choice stands over both.
// - T-4: a terminal prompt the host did not frame is drawn as Markdown, chat's
//   `<chat-readonly-markdown>` created through a fake `ui/v1`.
// - O2: the element's `toggle()` reports the opposite of what the block shows.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { blockOpen } from 'desktop/ui/collapsible-block';

import type { ChatInputView } from '../../src/client/peers.js';
import {
  installWindow,
  type MountedElement,
  mountElement,
  settle,
} from './support/render.js';
import { fakeServices } from './support/services.js';
import { loadStylesheetsAsEmpty } from './support/stylesheets.js';
import { terminalHost } from './support/terminal-host.js';

loadStylesheetsAsEmpty();

const projectId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const promptId = '33333333-3333-4333-8333-333333333333';
const terminalId = 'terminal-3f8a';

/** The prompt the host writes when a background command settles. */
const answer = (input: {
  readonly exitCode?: number;
  readonly reason?: string;
  readonly stdout?: string;
  readonly stderr?: string;
}): string =>
  [
    '# Background terminal result',
    '',
    `Terminal: ${terminalId}`,
    'Originating prompt: a0000000-0000-4000-8000-000000003099',
    'Command: npm test -- --run src/checkout',
    `Exit code: ${input.exitCode ?? 0}`,
    `Reason: ${input.reason ?? 'exited'}`,
    'Duration: 1940 ms',
    '',
    '## Standard output (last 12000 characters)',
    '',
    input.stdout ?? 'Test Files  2 passed (2)',
    '',
    '## Standard error (last 12000 characters)',
    '',
    input.stderr ?? '',
  ].join('\n');

/** The `view` the chat sets on the element for one terminal prompt. */
const inputView = (
  text: string,
  chosen: boolean | null = null,
): ChatInputView => ({
  projectId,
  threadId,
  promptId,
  source: { kind: 'terminal', terminalId },
  text,
  chosen,
  focused: false,
});

let mounted: MountedElement<ChatInputView> | undefined;
let mounts = 0;

afterEach(() => {
  mounted?.cleanup();
  mounted = undefined;
});

/**
 * Mounts `terminal-result` alone with `view`, as the chat creates it, and
 * records the Markdown created through `ui/v1`.
 */
const mountResult = async (
  view: ChatInputView,
): Promise<MountedElement<ChatInputView> & { readonly markdown: string[] }> => {
  installWindow();
  loadStylesheetsAsEmpty();
  const { TERMINAL_RESULT_TAG, defineTerminalResultElement } = await import(
    '../../src/client/chat/terminal-result.js'
  );
  assert.equal(TERMINAL_RESULT_TAG, 'terminal-result');
  const host = await terminalHost();
  const markdown: string[] = [];
  const { services } = fakeServices({
    'ui/v1': {
      define: () => ({ dispose: () => undefined }),
      // Chat's read-only Markdown, as plain text the block holds.
      create: (tag: string, props?: { readonly text?: string }) => {
        assert.equal(tag, 'chat-readonly-markdown');
        markdown.push(props?.text ?? '');
        const element = document.createElement('div');
        element.setAttribute('data-slot', 'readonly-markdown');
        element.textContent = props?.text ?? '';
        return element;
      },
      dispose: () => undefined,
    },
  });
  mounts += 1;
  mounted = await mountElement(
    `${TERMINAL_RESULT_TAG}-${mounts}`,
    defineTerminalResultElement(host.client),
    { services, view },
  );
  return Object.assign(mounted, { markdown });
};

/** The block the element draws, by its root slot. */
const blockOf = (element: HTMLElement): HTMLElement => {
  const block = element.querySelector<HTMLElement>(
    '[data-slot="terminal-result"]',
  );
  assert.ok(block, 'the element draws the result block');
  return block;
};

const headerOf = (element: HTMLElement): HTMLButtonElement | null =>
  blockOf(element).querySelector<HTMLButtonElement>(
    'button[aria-label^="Toggle background"]',
  );

/** The card inside the block, drawn only while the block is open. */
const cardOf = (element: HTMLElement): HTMLElement | null =>
  blockOf(element).querySelector<HTMLElement>('[data-slot="terminal-result"]');

describe('the background terminal result, mounted alone (AC5.3)', () => {
  test('a background terminal result draws as its own block, and folds away when it finished cleanly', async () => {
    const result = await mountResult(inputView(answer({})));

    assert.doesNotMatch(
      result.element.textContent ?? '',
      /# Background terminal result/,
    );
    assert.match(
      headerOf(result.element)?.textContent ?? '',
      /Background terminal/,
    );
    assert.match(
      headerOf(result.element)?.textContent ?? '',
      /npm test -- --run src\/checkout/,
    );
    // Folded: the card is the block's detail, and it is not drawn yet.
    assert.equal(cardOf(result.element) === null, true, 'the card is drawn');

    headerOf(result.element)?.click();
    await settle();
    assert.deepEqual(result.chosen, [true], 'the header reports chosen true');

    await result.setView(inputView(answer({}), true));
    const card = cardOf(result.element);
    assert.equal(
      card?.querySelector('[data-slot="terminal-result-command"]')?.textContent,
      '$npm test -- --run src/checkout',
    );
    assert.equal(
      card?.querySelector('[data-slot="terminal-result-stdout"]')?.textContent,
      'Test Files  2 passed (2)',
    );
    // The card keeps the terminal tool's shape: no exit-code row of its own.
    assert.equal(card?.textContent?.includes('exit 0'), false);
  });

  test('a background terminal result that failed is open, with its stderr in the tone of a failure', async () => {
    const result = await mountResult(
      inputView(
        answer({ exitCode: 1, stderr: 'AssertionError: expected primary' }),
      ),
    );

    assert.match(
      headerOf(result.element)?.textContent ?? '',
      /Background terminal failed/,
    );
    const stderr = cardOf(result.element)?.querySelector<HTMLElement>(
      '[data-slot="terminal-result-stderr"]',
    );
    assert.notEqual(stderr, null);
    assert.match(stderr?.textContent ?? '', /AssertionError/);
    assert.equal(stderr?.className.includes('text-destructive'), true);
  });

  test('a terminal prompt the host did not frame is drawn as Markdown, with its text (T-4)', async () => {
    const text = 'output without the host header\n\n- one\n- two';
    const result = await mountResult(inputView(text, true));

    assert.deepEqual(result.markdown, [text]);
    assert.equal(
      result.element.querySelector('[data-slot="readonly-markdown"]')
        ?.textContent,
      text,
    );
    assert.equal(
      result.element.querySelector('[data-slot="terminal-result-command"]') ===
        null,
      true,
      'the text is read as a background result',
    );
  });
});

describe('terminalResultOpenness, the open rule of the result block', () => {
  test('a background terminal result is folded when it finished cleanly', async () => {
    installWindow();
    const { terminalResultOpenness } = await import(
      '../../src/client/chat/terminal-result.js'
    );

    assert.equal(blockOpen(null, terminalResultOpenness(false)), false);
  });

  test('a background terminal result is open when its command did not finish cleanly', async () => {
    installWindow();
    const { terminalResultOpenness } = await import(
      '../../src/client/chat/terminal-result.js'
    );

    assert.equal(blockOpen(null, terminalResultOpenness(true)), true);
  });

  test("the reader's choice on a terminal result stands over the outcome", async () => {
    installWindow();
    const { terminalResultOpenness } = await import(
      '../../src/client/chat/terminal-result.js'
    );

    assert.equal(blockOpen(true, terminalResultOpenness(false)), true);
    assert.equal(blockOpen(false, terminalResultOpenness(true)), false);
  });
});

describe('the toggle key on the result block (O2)', () => {
  test('toggle() on a failed result, open on its own, reports chosen false', async () => {
    const result = await mountResult(inputView(answer({ exitCode: 1 })));
    assert.equal(typeof result.element.toggle, 'function');

    result.element.toggle?.();
    await settle();
    assert.deepEqual(result.chosen, [false]);
  });

  test('toggle() on a clean result, folded on its own, reports chosen true', async () => {
    const result = await mountResult(inputView(answer({})));
    assert.equal(typeof result.element.toggle, 'function');

    result.element.toggle?.();
    await settle();
    assert.deepEqual(result.chosen, [true]);
  });

  test("toggle() reports the opposite of the reader's choice the view carries", async () => {
    const result = await mountResult(inputView(answer({ exitCode: 1 }), false));

    result.element.toggle?.();
    await settle();
    assert.deepEqual(result.chosen, [true]);
  });
});
