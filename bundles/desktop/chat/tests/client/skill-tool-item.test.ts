// A `load_skill` call as the reader meets it in a window: a block of its own
// that says which skill the agent loaded and where it came from — loading while
// the call runs, folded once it loaded with the skill's text as inert detail,
// open with its error when the load failed — instead of the generic
// `Called load skill` row every other tool draws.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { type ChatWindow, openChatWindow, settle } from './support/window.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const promptId = '33333333-3333-4333-8333-333333333333';
const url = `doric://app/projects/${projectId}/threads/${threadId}`;

const thread = (overrides: Record<string, unknown> = {}) => ({
  id: threadId,
  name: 'Write the tests',
  projectId,
  state: 'idle',
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
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
  createdAt: `2026-01-01T00:00:0${sequence}.000Z`,
});

const emptyQueue = { revision: 1, paused: false, stopping: false, items: [] };

const host = (record: unknown) => ({
  'runtime.threads/v1.thread': () => record,
  'runtime.threads/v1.queue': () => emptyQueue,
});

/** The skill's instructions, Markdown the block must show as plain text. */
const skillText = [
  '# Behavioral Testing',
  '',
  'Write tests from **public behavior**, not from the implementation.',
].join('\n');

const skillCall = (name: string) => ({
  id: 'call-skill',
  name: 'load_skill',
  payload: { name },
});

const asked = event(1, {
  type: 'prompt.accepted',
  text: 'Write the tests',
  source: { kind: 'user' },
});
const loading = (name: string) =>
  event(2, { type: 'tool.started', call: skillCall(name) });
const loaded = (name: string) =>
  event(3, {
    type: 'tool.finished',
    call: skillCall(name),
    record: { output: skillText },
  });
const failed = (name: string) =>
  event(3, {
    type: 'tool.failed',
    call: skillCall(name),
    error: { message: 'No skill is named cwd/missing-skill.' },
  });
const finished = event(4, {
  type: 'prompt.finished',
  status: 'completed',
  text: '',
  source: { kind: 'user' },
});

let opened: ChatWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

/** Opens the Thread and delivers `events` as its log. */
const deliver = async (events: readonly unknown[]): Promise<ChatWindow> => {
  opened = await openChatWindow({ url, host: host(thread()) });
  const watch = opened.watches().at(-1);
  assert.equal(
    watch !== undefined,
    true,
    'the conversation watches its Thread',
  );
  watch?.push({
    kind: 'snapshot',
    threadId,
    projectId,
    project: null,
    thread: thread(),
    events,
  });
  await settle(150);
  return opened;
};

/** The transcript's row that draws the skill call. */
const skillRow = (window: ChatWindow): Element | undefined =>
  [
    ...(window.document.querySelector('[data-lexical-editor]')?.children ?? []),
  ].find((row) => /skill/i.test(row.textContent ?? ''));

const viewText = (window: ChatWindow): string =>
  window.document.querySelector('chat-view')?.textContent ?? '';

test('a loading skill call says it is loading the skill it names', async () => {
  const window = await deliver([asked, loading('git-cloning')]);

  const row = skillRow(window);
  assert.ok(row, 'the skill call draws a row');
  assert.match(row.textContent ?? '', /Loading skill\s+git-cloning/);
  assert.match(row.textContent ?? '', /built-in/);
  assert.doesNotMatch(viewText(window), /Call(ing|ed) load skill/);
});

test('a loaded workspace skill folds away, and opening it shows its text as written', async () => {
  const window = await deliver([
    asked,
    loading('cwd/behavioral-testing'),
    loaded('cwd/behavioral-testing'),
    finished,
  ]);

  const row = skillRow(window);
  assert.ok(row, 'the skill call draws a row');
  assert.match(row.textContent ?? '', /Loaded skill\s+behavioral-testing/);
  assert.match(row.textContent ?? '', /workspace/);
  // The locator's prefix is the source's business, not the skill's name.
  assert.doesNotMatch(row.textContent ?? '', /cwd\//);
  // Folded: the skill's instructions are the block's detail, and not drawn.
  assert.doesNotMatch(row.textContent ?? '', /public behavior/);
  assert.doesNotMatch(viewText(window), /Call(ing|ed) load skill/);

  row.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')?.click();
  await settle(100);

  // Open: the text reads as it was returned, its Markdown markers kept as
  // characters instead of drawn as a heading or bold.
  const open = skillRow(window);
  assert.ok(open);
  assert.match(open.textContent ?? '', /# Behavioral Testing/);
  assert.match(open.textContent ?? '', /\*\*public behavior\*\*/);
  assert.equal(open.querySelector('h1, h2, h3, strong, b'), null);
});

test('a skill that failed to load is open with its error', async () => {
  const window = await deliver([
    asked,
    loading('cwd/missing-skill'),
    failed('cwd/missing-skill'),
    finished,
  ]);

  const row = skillRow(window);
  assert.ok(row, 'the skill call draws a row');
  assert.match(row.textContent ?? '', /Failed to load skill\s+missing-skill/);
  assert.match(row.textContent ?? '', /No skill is named cwd\/missing-skill\./);
});

test("an MCP server's skill names the server it came from", async () => {
  const window = await deliver([
    asked,
    loading('mcp/acme/refunds'),
    loaded('mcp/acme/refunds'),
    finished,
  ]);

  const row = skillRow(window);
  assert.ok(row, 'the skill call draws a row');
  assert.match(row.textContent ?? '', /Loaded skill\s+refunds/);
  assert.match(row.textContent ?? '', /MCP · acme/);
  assert.doesNotMatch(row.textContent ?? '', /mcp\/acme/);
});
