// The `terminal-tool-call` element (bundle isolation 5(b), change 4): the row
// of a `terminal` call, moved from the chat's
// `components/molecules/terminal-tool-item.tsx` and registered through
// `chat.views/v1` 1.2.0.
// - AC5.3: the row's cases, moved from the chat's
//   `tests/client/terminal-result.test.ts` (the truncated command, T-19),
//   mount the element alone with the `view` the chat sets for the call (no
//   chat window, no chat built part) and select it by its
//   `data-slot="terminal-tool"`.
// - T-3, S-7 (what the chat's `stores/live-terminals.ts` did, now over this
//   bundle's store): the row shows its terminal's live output and Stop; it
//   watches the output only while the terminal runs, and closes the watch
//   when the terminal exits or the element leaves; it draws chunks at most
//   every 50 ms; it never unfollows the Project (the sidebar follows it too).
// - OD-2, OD-3: Stop calls the store's `stop` and is gone at once, for the
//   element's life; a refused stop shows the store's toast.
// - O2: `toggle()` answers the live rule: a call whose terminal still runs is
//   open, whatever its status.
// The host boundary is faked (`support/terminal-host.ts`): the Project's
// terminal stream, the output watch and the stop call; the store is real.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { errorInfo } from 'desktop/reads';

import type { Terminal } from '../../src/client/domain/terminals.js';
import type { ChatToolView } from '../../src/client/peers.js';
import { assertToolNotice } from './support/notices.js';
import {
  installWindow,
  type MountedElement,
  mountElement,
  settle,
} from './support/render.js';
import { fakeServices } from './support/services.js';
import { loadStylesheetsAsEmpty } from './support/stylesheets.js';
import { type TerminalHost, terminalHost } from './support/terminal-host.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const threadId = '22222222-2222-4222-8222-222222222222';
const promptId = '33333333-3333-4333-8333-333333333333';
const failedAt = '2026-01-01T00:00:03.000Z';

/** The agent's terminal a `npm test` call started on the Thread. */
const agentTerminal = (overrides: Partial<Terminal> = {}): Terminal => ({
  id: 'term-1',
  projectId,
  threadId,
  origin: 'agent',
  command: 'npm test',
  cwd: '/workspace',
  startedAt: '2026-01-01T00:00:00.000Z',
  timeoutMs: 120_000,
  state: 'running',
  pty: false,
  ...overrides,
});

/** The `view` the chat sets on the element for one `terminal` call. */
const callView = (input: {
  readonly status: ChatToolView['status'];
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly result?: string;
  readonly error?: ChatToolView['error'];
  readonly chosen?: boolean | null;
}): ChatToolView => ({
  projectId,
  threadId,
  promptId,
  key: `${promptId}/call-term-1`,
  name: 'terminal',
  args: JSON.stringify(
    input.payload ?? { command: 'npm test', working_directory: '/workspace' },
  ),
  ...(input.result === undefined ? {} : { result: input.result }),
  ...(input.error === undefined ? {} : { error: input.error }),
  status: input.status,
  chosen: input.chosen ?? null,
  focused: false,
});

/** A settled run's `terminal.compact.v1` record. */
const compactRecord = JSON.stringify({
  schema: 'terminal.compact.v1',
  trace_id: null,
  command: 'npm test',
  working_directory: '/workspace',
  exit_code: 0,
  duration_ms: 1200,
  termination_reason: 'exited',
  success: true,
  stdout: {
    bytes: 12,
    lines: 1,
    head: ['1 passing'],
    tail: [],
    omitted_lines: 0,
    omitted_bytes: 0,
    truncated: false,
  },
  stderr: {
    bytes: 0,
    lines: 0,
    head: [],
    tail: [],
    omitted_lines: 0,
    omitted_bytes: 0,
    truncated: false,
  },
  diagnostics: [],
  truncation: { truncated: false, message: 'ok' },
  raw_output_ref: null,
});

const running = () => callView({ status: 'running' });
const ran = (chosen: boolean | null = null) =>
  callView({ status: 'finished', result: compactRecord, chosen });
/** A call the agent left running in the background: it settles at once. */
const startedInBackground = () =>
  callView({
    status: 'finished',
    payload: { command: 'npm test', background: true },
    result: JSON.stringify({ terminal_id: 'term-1', background: true }),
  });

let mounted: MountedElement<ChatToolView> | undefined;
let mounts = 0;

afterEach(() => {
  mounted?.cleanup();
  mounted = undefined;
});

/**
 * Mounts `terminal-tool-call` alone with `view` over `host`'s client, as the
 * chat creates it. Each mount defines the element under a tag of its own,
 * since each test builds the class over its own client.
 */
const mountCall = async (
  host: TerminalHost,
  view: ChatToolView,
): Promise<MountedElement<ChatToolView>> => {
  installWindow();
  loadStylesheetsAsEmpty();
  const { TERMINAL_CALL_TAG, defineTerminalCallElement } = await import(
    '../../src/client/chat/terminal-call.js'
  );
  assert.equal(TERMINAL_CALL_TAG, 'terminal-tool-call');
  mounts += 1;
  const { services } = fakeServices({});
  mounted = await mountElement(
    `${TERMINAL_CALL_TAG}-${mounts}`,
    defineTerminalCallElement(host.client),
    { services, view },
  );
  return mounted;
};

/** Mounts a call and sends its Project's list holding `terminals`. */
const mountWithTerminals = async (
  view: ChatToolView,
  terminals: readonly Terminal[],
  host?: TerminalHost,
): Promise<{ host: TerminalHost; call: MountedElement<ChatToolView> }> => {
  const fake = host ?? (await terminalHost());
  const call = await mountCall(fake, view);
  fake.list(projectId, terminals);
  await settle();
  return { host: fake, call };
};

/** The row the element draws, by its slot. */
const rowOf = (element: HTMLElement): HTMLElement => {
  const row = element.querySelector<HTMLElement>('[data-slot="terminal-tool"]');
  assert.ok(row, 'the element draws the terminal row');
  return row;
};

const liveOutputOf = (element: HTMLElement): string | undefined =>
  element.querySelector('[data-slot="terminal-live-output"]')?.textContent ??
  undefined;

const stopOf = (element: HTMLElement): HTMLElement | null =>
  element.querySelector<HTMLElement>('[data-slot="terminal-stop"]');

/** Whether the row offers Stop (a boolean, so a failure prints no element). */
const showsStop = (element: HTMLElement): boolean => stopOf(element) !== null;

/** Waits past the 50 ms the row waits between two drawings of its output. */
const pastThrottle = async (): Promise<void> => {
  await new Promise<void>((done) => setTimeout(done, 80));
  await settle();
};

/** Runs the immediates React and the fakes queued, without letting time pass. */
const flushImmediates = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1)
    await new Promise<void>((done) => setImmediate(done));
};

describe('the terminal row, mounted alone (AC5.3)', () => {
  test('a running call shows its command on a single truncated line inside the card', async () => {
    const host = await terminalHost();
    const call = await mountCall(
      host,
      callView({
        status: 'running',
        payload: {
          command:
            'npm test -- --watch --very-long-flag-that-truncates-on-one-line',
        },
      }),
    );

    // While running, the card is open and shows the command on one line.
    const commandRow = rowOf(call.element).querySelector(
      '[data-slot="terminal-command"]',
    );
    assert.notEqual(commandRow, null);
    assert.equal(commandRow?.className.includes('truncate'), true);
  });

  test('T-19 a terminal call the tool failed shows the compact tool notice naming the call', async () => {
    const host = await terminalHost();
    const call = await mountCall(
      host,
      callView({
        status: 'failed',
        error: errorInfo(
          { message: 'The working directory is outside the project.' },
          { at: failedAt },
        ),
      }),
    );

    await assertToolNotice(rowOf(call.element), {
      title: 'Tool failed',
      explanation: 'The working directory is outside the project.',
      tool: 'terminal',
    });
  });
});

describe("the terminal row's live output (T-3)", () => {
  test("a running call follows its Project's terminals through the store", async () => {
    const host = await terminalHost();
    await mountCall(host, running());

    assert.deepEqual(host.followed, [projectId]);
  });

  test('a running call whose agent terminal runs shows its live output and Stop', async () => {
    const { host, call } = await mountWithTerminals(running(), [
      agentTerminal(),
    ]);
    assert.deepEqual(host.watched, ['term-1']);

    host.output('term-1', { kind: 'snapshot', data: 'line 1\n', sequence: 7 });
    host.output('term-1', { kind: 'output', data: 'line 2\n', sequence: 14 });
    await pastThrottle();

    assert.equal(liveOutputOf(call.element), 'line 1\nline 2\n');
    assert.equal(showsStop(call.element), true);
    assert.match(rowOf(call.element).textContent ?? '', /Running/);
  });

  test('a call the agent left in the background shows the output of its terminal while it runs', async () => {
    const { host, call } = await mountWithTerminals(startedInBackground(), [
      agentTerminal(),
    ]);
    assert.deepEqual(host.watched, ['term-1']);

    host.output('term-1', {
      kind: 'snapshot',
      data: 'ready on :3000\n',
      sequence: 15,
    });
    await pastThrottle();

    assert.equal(liveOutputOf(call.element), 'ready on :3000\n');
    assert.equal(showsStop(call.element), true);
  });

  test('a settled call with no running terminal opens no watch', async () => {
    const { host, call } = await mountWithTerminals(ran(), [
      agentTerminal({ state: 'exited' }),
    ]);

    assert.deepEqual(host.watched, []);
    assert.equal(showsStop(call.element), false);
  });

  test('a call left in the background whose terminal has exited opens no watch', async () => {
    const { host, call } = await mountWithTerminals(startedInBackground(), [
      agentTerminal({ state: 'exited' }),
    ]);

    assert.deepEqual(host.watched, []);
    assert.equal(showsStop(call.element), false);
  });

  test('the watch closes when the terminal exits', async () => {
    const { host, call } = await mountWithTerminals(running(), [
      agentTerminal(),
    ]);
    assert.deepEqual(host.watched, ['term-1']);
    assert.deepEqual(host.watchesClosed, []);

    host.update(agentTerminal({ state: 'exited' }));
    await settle();

    assert.deepEqual(host.watchesClosed, ['term-1']);
    assert.equal(showsStop(call.element), false);
  });

  test('removing the element closes the watch and leaves the Project followed', async () => {
    const { host, call } = await mountWithTerminals(running(), [
      agentTerminal(),
    ]);
    assert.deepEqual(host.watched, ['term-1']);

    call.cleanup();
    mounted = undefined;
    await settle();

    assert.deepEqual(host.watchesClosed, ['term-1']);
    // The sidebar's rows read the same followed Project: no unfollow.
    assert.deepEqual(host.unfollowed, []);
    assert.deepEqual(host.listsClosed, []);
  });

  test('chunks that arrive within 50 ms are drawn once', async (t) => {
    const { host, call } = await mountWithTerminals(running(), [
      agentTerminal(),
    ]);
    host.output('term-1', { kind: 'snapshot', data: '', sequence: 0 });
    await pastThrottle();

    // No time passes from here on until the clock is moved on by hand; the
    // last drawing lies well over 50 ms behind.
    t.mock.timers.enable({
      apis: ['setTimeout', 'Date'],
      now: Date.now() + 1_000,
    });
    try {
      const drawn: (string | undefined)[] = [];
      host.output('term-1', { kind: 'output', data: 'one\n', sequence: 4 });
      await flushImmediates();
      drawn.push(liveOutputOf(call.element));
      host.output('term-1', { kind: 'output', data: 'two\n', sequence: 8 });
      await flushImmediates();
      drawn.push(liveOutputOf(call.element));
      host.output('term-1', { kind: 'output', data: 'three\n', sequence: 14 });
      await flushImmediates();
      drawn.push(liveOutputOf(call.element));

      // Drawn at most once in the window: never the second chunk alone.
      assert.ok(
        !drawn.includes('one\ntwo\n'),
        `drawn: ${JSON.stringify(drawn)}`,
      );

      t.mock.timers.tick(50);
      await flushImmediates();
      assert.equal(liveOutputOf(call.element), 'one\ntwo\nthree\n');
    } finally {
      t.mock.timers.reset();
    }
  });
});

describe("the terminal row's Stop (OD-2, OD-3)", () => {
  test('Stop asks the store to stop the terminal and is gone at once, for the life of the row', async () => {
    const { host, call } = await mountWithTerminals(running(), [
      agentTerminal(),
    ]);
    const stop = stopOf(call.element);
    assert.ok(stop, 'the row offers Stop');

    stop.click();
    await settle();

    assert.deepEqual(host.stopped, ['term-1']);
    // The terminal's stream still says it runs: Stop stays gone all the same.
    assert.equal(showsStop(call.element), false);
    host.update(agentTerminal({ state: 'running' }));
    await settle();
    assert.equal(showsStop(call.element), false);
  });

  test("a stop the host refuses shows the store's toast", async () => {
    const host = await terminalHost({
      stopFails: 'The terminal could not be stopped.',
    });
    const { call } = await mountWithTerminals(
      running(),
      [agentTerminal()],
      host,
    );

    stopOf(call.element)?.click();
    await settle();

    assert.deepEqual(host.stopped, ['term-1']);
    assert.deepEqual(host.toasts, ['The terminal could not be stopped.']);
    assert.equal(showsStop(call.element), false);
  });
});

describe('the toggle key on the terminal row (O2)', () => {
  test('toggle() on a call left in the background whose terminal still runs, open on its own, reports chosen false', async () => {
    const { call } = await mountWithTerminals(startedInBackground(), [
      agentTerminal(),
    ]);
    assert.equal(typeof call.element.toggle, 'function');

    call.element.toggle?.();
    await settle();
    assert.deepEqual(call.chosen, [false]);
  });

  test('toggle() on a running call, open on its own, reports chosen false', async () => {
    const { call } = await mountWithTerminals(running(), [agentTerminal()]);

    call.element.toggle?.();
    await settle();
    assert.deepEqual(call.chosen, [false]);
  });

  test('toggle() on a settled call with no live terminal, folded on its own, reports chosen true', async () => {
    const { call } = await mountWithTerminals(ran(), []);
    assert.equal(typeof call.element.toggle, 'function');

    call.element.toggle?.();
    await settle();
    assert.deepEqual(call.chosen, [true]);
  });

  test("toggle() reports the opposite of the reader's choice the view carries", async () => {
    const { call } = await mountWithTerminals(ran(true), []);

    call.element.toggle?.();
    await settle();
    assert.deepEqual(call.chosen, [false]);
  });
});
