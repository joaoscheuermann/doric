// A background terminal's answer as the reader meets it in a window: the prompt
// the host enqueues when the command settles drawn as its own block — the
// command, how it exited and the streams — folded away when the command
// finished cleanly and open when it did not, instead of the Markdown the host
// framed it in.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { type ChatWindow, openChatWindow, settle } from './support/window.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const promptId = '33333333-3333-4333-8333-333333333333';
const url = `doric://app/projects/${projectId}/threads/${threadId}`;

const terminalId = 'terminal-3f8a';

const thread = {
  id: threadId,
  name: 'Watch the checkout tests',
  projectId,
  state: 'idle',
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

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

const host = {
  'runtime.threads/v1.thread': () => thread,
  'runtime.threads/v1.queue': () => ({
    revision: 1,
    paused: false,
    stopping: false,
    items: [],
  }),
};

let opened: ChatWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

/** Opens the Thread and delivers the log of a settled background command. */
const open = async (answer: string): Promise<ChatWindow> => {
  opened = await openChatWindow({ url, host });
  opened
    .watches()
    .at(-1)
    ?.push({
      kind: 'snapshot',
      threadId,
      projectId,
      project: null,
      thread,
      events: [
        event(1, {
          type: 'prompt.accepted',
          text: answer,
          source: { kind: 'terminal', terminalId },
        }),
      ],
    });
  await settle(200);
  return opened;
};

const block = (window: ChatWindow): HTMLElement | null =>
  window.document.querySelector(`[data-terminal-id="${terminalId}"]`);

const header = (window: ChatWindow): HTMLButtonElement | null =>
  block(window)?.querySelector('button[aria-label^="Toggle background"]') ??
  null;

const card = (window: ChatWindow): HTMLElement | null =>
  block(window)?.querySelector('[data-slot="terminal-result"]') ?? null;

const showsTranscriptHeading = (window: ChatWindow): boolean =>
  /# Background terminal result/.test(
    window.document.querySelector('chat-view')?.textContent ?? '',
  );

test('a background terminal result draws as its own block, and folds away when it finished cleanly', async () => {
  const window = await open(answer({}));

  assert.notEqual(block(window), null);
  assert.equal(showsTranscriptHeading(window), false);
  assert.match(header(window)?.textContent ?? '', /Background terminal/);
  assert.match(
    header(window)?.textContent ?? '',
    /npm test -- --run src\/checkout/,
  );
  // Folded: the card is the block's detail, and it is not drawn yet.
  assert.equal(card(window), null);

  header(window)?.click();
  await settle(100);

  assert.equal(
    card(window)?.querySelector('[data-slot="terminal-result-command"]')
      ?.textContent,
    '$npm test -- --run src/checkout',
  );
  assert.equal(
    card(window)?.querySelector('[data-slot="terminal-result-stdout"]')
      ?.textContent,
    'Test Files  2 passed (2)',
  );
  // The card keeps the terminal tool's shape: no exit-code row of its own.
  assert.equal(card(window)?.textContent?.includes('exit 0'), false);
});

test('a background terminal result that failed is open, with its stderr in the tone of a failure', async () => {
  const window = await open(
    answer({ exitCode: 1, stderr: 'AssertionError: expected primary' }),
  );

  assert.match(header(window)?.textContent ?? '', /Background terminal failed/);
  const stderr = card(window)?.querySelector<HTMLElement>(
    '[data-slot="terminal-result-stderr"]',
  );
  assert.notEqual(stderr, null);
  assert.match(stderr?.textContent ?? '', /AssertionError/);
  assert.equal(stderr?.className.includes('text-destructive'), true);
});
