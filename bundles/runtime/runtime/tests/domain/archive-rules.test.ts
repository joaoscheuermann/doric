import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import type { Thread } from '../../src/contracts/model.js';
import {
  type ArchiveFacts,
  type AutoArchiveSettings,
  autoArchiveSettings,
  blockingResult,
  dayMs,
  finishedDue,
  inactiveDue,
  manualArchiveSet,
  pending,
  restoreSet,
} from '../../src/host/domain/archive.js';
import { defaultConfiguration } from './support/harness.js';

/*
 * The archive rules of docs/designs/thread-archive.md §2 (T-1 … T-4): pure
 * functions over the facts of one Thread, times in epoch milliseconds. Every
 * expected time is stated from the spec's rules, never computed by the code
 * under test.
 */

const base = Date.parse('2026-11-01T00:00:00.000Z');
const second = 1000;
const hour = 3_600_000;
/** The ISO time `ms` after `base`. */
const at = (ms: number) => new Date(base + ms).toISOString();

const projectId = randomUUID();
const mainId = randomUUID();

const record = (fields: Partial<Thread> = {}): Thread => ({
  id: randomUUID(),
  projectId,
  name: 'Thread',
  state: 'ready',
  lastSequence: 4,
  cwd: '/workspace',
  createdAt: at(0),
  updatedAt: at(0),
  ...fields,
});

const factsOf = (
  fields: Partial<Thread> = {},
  extra: Partial<Omit<ArchiveFacts, 'thread'>> = {},
): ArchiveFacts => ({
  thread: record(fields),
  interrupted: false,
  busy: false,
  viewing: false,
  question: false,
  ...extra,
});

const result = (ms: number, status = 'completed') => ({
  status,
  text: 'done',
  promptId: randomUUID(),
  at: at(ms),
});

const settings: AutoArchiveSettings = {
  agentThreads: true,
  mainThreadsAfterMs: 7 * dayMs,
};

/** An agent thread whose turn completed one minute after `base`. */
const finishedChild = (
  fields: Partial<Thread> = {},
  extra: Partial<Omit<ArchiveFacts, 'thread'>> = {},
) =>
  factsOf(
    {
      origin: 'agent',
      parentThreadId: mainId,
      result: result(60 * second),
      ...fields,
    },
    extra,
  );

const archived = { archivedAt: at(0) };
const batchOf = { batch: randomUUID() };

void test('autoArchiveSettings applies the defaults and maps each mainThreadsAfter choice', () => {
  assert.deepEqual(autoArchiveSettings(defaultConfiguration), {
    agentThreads: true,
    mainThreadsAfterMs: 7 * dayMs,
  });
  for (const [choice, days] of [
    ['1d', 1],
    ['7d', 7],
    ['30d', 30],
  ] as const)
    assert.equal(
      autoArchiveSettings({
        ...defaultConfiguration,
        threads: { autoArchive: { mainThreadsAfter: choice } },
      }).mainThreadsAfterMs,
      days * dayMs,
      choice,
    );
  const never = autoArchiveSettings({
    ...defaultConfiguration,
    threads: {
      autoArchive: { agentThreads: false, mainThreadsAfter: 'never' },
    },
  });
  assert.equal(never.agentThreads, false);
  assert.equal(never.mainThreadsAfterMs, undefined);
  assert.deepEqual(
    autoArchiveSettings({ ...defaultConfiguration, threads: {} }),
    { agentThreads: true, mainThreadsAfterMs: 7 * dayMs },
  );
});

void test('blockingResult blocks a failed result and a reader-stopped one only', () => {
  assert.equal(
    blockingResult(finishedChild({ result: result(0, 'failed') })),
    true,
  );
  assert.equal(
    blockingResult(
      finishedChild({ result: result(0, 'cancelled') }, { interrupted: true }),
    ),
    true,
  );
  assert.equal(
    blockingResult(finishedChild({ result: result(0, 'cancelled') })),
    false,
  );
  assert.equal(blockingResult(finishedChild()), false);
});

// T-1 ---------------------------------------------------------------------

void test('finishedDue archives an eligible agent thread 30 s after its result', () => {
  assert.equal(finishedDue(finishedChild(), settings), base + 90 * second);
});

void test('finishedDue waits 30 s after a view that ended after the result', () => {
  assert.equal(
    finishedDue(finishedChild({}, { viewedAt: at(70 * second) }), settings),
    base + 100 * second,
  );
  // A view that ended before the result does not move it.
  assert.equal(
    finishedDue(finishedChild({}, { viewedAt: at(50 * second) }), settings),
    base + 90 * second,
  );
});

void test('finishedDue treats the state cancelled and a cancelled result without reason as eligible', () => {
  assert.equal(
    finishedDue(finishedChild({ state: 'cancelled' }), settings),
    base + 90 * second,
  );
  assert.equal(
    finishedDue(
      finishedChild({ result: result(60 * second, 'cancelled') }),
      settings,
    ),
    base + 90 * second,
  );
});

void test('finishedDue answers for a turn that ended after a restore', () => {
  assert.equal(
    finishedDue(
      finishedChild({}, { restoredAt: at(60 * second - 1) }),
      settings,
    ),
    base + 90 * second,
  );
});

void test('finishedDue answers undefined for every blocker of the agent-thread rule', () => {
  const blocked: readonly (readonly [
    string,
    ArchiveFacts,
    AutoArchiveSettings?,
  ])[] = [
    ['the toggle off', finishedChild(), { ...settings, agentThreads: false }],
    ['origin user', finishedChild({ origin: 'user' })],
    ['no parent', finishedChild({ parentThreadId: undefined })],
    ['archived', finishedChild(archived, batchOf)],
    ['pinned', finishedChild({ pinned: true })],
    ['state queued', finishedChild({ state: 'queued' })],
    ['state running', finishedChild({ state: 'running' })],
    ['state cancelling', finishedChild({ state: 'cancelling' })],
    ['state failed', finishedChild({ state: 'failed' })],
    ['a paused queue', finishedChild({ queuePaused: true })],
    ['a question', finishedChild({}, { question: true })],
    ['busy', finishedChild({}, { busy: true })],
    ['viewing', finishedChild({}, { viewing: true })],
    ['no result', finishedChild({ result: undefined })],
    [
      'a failed result',
      finishedChild({ result: result(60 * second, 'failed') }),
    ],
    [
      'a reader-stopped result',
      finishedChild(
        { result: result(60 * second, 'cancelled') },
        { interrupted: true },
      ),
    ],
    [
      'a result at the restore time',
      finishedChild({}, { restoredAt: at(60 * second) }),
    ],
  ];
  for (const [what, facts, rule = settings] of blocked)
    assert.equal(finishedDue(facts, rule), undefined, what);
});

// T-2 ---------------------------------------------------------------------

/** A main thread created at `base` whose turn ended one hour later. */
const mainThread = (
  fields: Partial<Thread> = {},
  extra: Partial<Omit<ArchiveFacts, 'thread'>> = {},
) =>
  factsOf(
    { id: mainId, origin: 'user', result: result(hour), ...fields },
    extra,
  );

/** An agent child of the main thread, created at 2 h, finished at 3 h. */
const child = (
  fields: Partial<Thread> = {},
  extra: Partial<Omit<ArchiveFacts, 'thread'>> = {},
) =>
  factsOf(
    {
      origin: 'agent',
      parentThreadId: mainId,
      createdAt: at(2 * hour),
      result: result(3 * hour),
      ...fields,
    },
    extra,
  );

void test('inactiveDue archives a main thread N days after the latest createdAt or result of its subtree', () => {
  assert.equal(
    inactiveDue(mainThread(), [], settings),
    base + hour + 7 * dayMs,
  );
  assert.equal(
    inactiveDue(mainThread(), [child()], settings),
    base + 3 * hour + 7 * dayMs,
  );
  // A child created later than every result counts by its createdAt.
  assert.equal(
    inactiveDue(
      mainThread(),
      [child({ createdAt: at(4 * hour), result: undefined, state: 'ready' })],
      settings,
    ),
    base + 4 * hour + 7 * dayMs,
  );
});

void test('inactiveDue counts the times of archived descendants', () => {
  assert.equal(
    inactiveDue(
      mainThread(),
      [child(), child({ ...archived, result: result(5 * hour) }, batchOf)],
      settings,
    ),
    base + 5 * hour + 7 * dayMs,
  );
});

void test('inactiveDue counts from a turn that ended after the root was restored', () => {
  assert.equal(
    inactiveDue(
      mainThread(
        { result: result(6 * hour + 1) },
        { restoredAt: at(6 * hour) },
      ),
      [child({ ...archived, result: result(5 * hour) }, batchOf)],
      settings,
    ),
    base + 6 * hour + 1 + 7 * dayMs,
  );
});

void test('inactiveDue follows the configured days and never archives with never', () => {
  assert.equal(
    inactiveDue(mainThread(), [], { ...settings, mainThreadsAfterMs: dayMs }),
    base + hour + dayMs,
  );
  assert.equal(
    inactiveDue(mainThread(), [], {
      ...settings,
      mainThreadsAfterMs: 30 * dayMs,
    }),
    base + hour + 30 * dayMs,
  );
  assert.equal(
    inactiveDue(mainThread(), [child()], { agentThreads: true }),
    undefined,
  );
});

void test('inactiveDue answers undefined for a root that is not a main thread or is archived', () => {
  assert.equal(
    inactiveDue(child(), [], settings),
    undefined,
    'a root with a parent',
  );
  assert.equal(
    inactiveDue(mainThread(archived, batchOf), [child()], settings),
    undefined,
    'an archived root',
  );
});

void test('inactiveDue answers undefined while any Thread of the subtree is pending', () => {
  const blocked: readonly (readonly [
    string,
    ArchiveFacts,
    readonly ArchiveFacts[],
  ])[] = [
    ['a pinned root', mainThread({ pinned: true }), [child()]],
    ['a pinned descendant', mainThread(), [child({ pinned: true })]],
    ['a failed descendant', mainThread(), [child({ state: 'failed' })]],
    ['a running descendant', mainThread(), [child({ state: 'running' })]],
    ['a queued descendant', mainThread(), [child({ state: 'queued' })]],
    ['a busy descendant', mainThread(), [child({}, { busy: true })]],
    ['a waiting descendant', mainThread(), [child({ queuePaused: true })]],
    [
      'a descendant with a question',
      mainThread(),
      [child({}, { question: true })],
    ],
    ['a viewed descendant', mainThread(), [child({}, { viewing: true })]],
    ['a viewed root', mainThread({}, { viewing: true }), []],
    ['an unread root', mainThread({}, { viewedAt: at(hour - 1) }), [child()]],
    [
      'an unread descendant',
      mainThread(),
      [child({}, { viewedAt: at(3 * hour - 1) })],
    ],
    [
      'a failed last result',
      mainThread({ result: result(hour, 'failed') }),
      [child()],
    ],
    [
      'a reader-stopped result',
      mainThread(),
      [child({ result: result(3 * hour, 'cancelled') }, { interrupted: true })],
    ],
    [
      'a root restored with no turn ended since (D6)',
      mainThread({}, { restoredAt: at(2 * hour) }),
      [child()],
    ],
    [
      'a descendant restored with no turn ended since (D6)',
      mainThread(),
      [child({}, { restoredAt: at(4 * hour) })],
    ],
    [
      'a descendant restored at its result time (D6)',
      mainThread(),
      [child({}, { restoredAt: at(3 * hour) })],
    ],
    [
      'a restored descendant without a result (D6)',
      mainThread(),
      [child({ result: undefined }, { restoredAt: at(4 * hour) })],
    ],
  ];
  for (const [what, root, descendants] of blocked)
    assert.equal(inactiveDue(root, descendants, settings), undefined, what);
});

void test('inactiveDue is not blocked by archived, cancelled or read descendants', () => {
  const due = base + 3 * hour + 7 * dayMs;
  const cases: readonly (readonly [string, readonly ArchiveFacts[]])[] = [
    [
      'an archived failed descendant',
      [
        child(),
        child(
          {
            ...archived,
            createdAt: at(0),
            state: 'failed',
            result: result(hour, 'failed'),
          },
          batchOf,
        ),
      ],
    ],
    ['a cancelled descendant', [child({ state: 'cancelled' })]],
    [
      'a cancelled result without reason',
      [child({ result: result(3 * hour, 'cancelled') })],
    ],
    [
      'a result read before the last view ended',
      [child({}, { viewedAt: at(3 * hour + 1) })],
    ],
    ['a never-viewed Thread with a result', [child()]],
  ];
  for (const [what, descendants] of cases)
    assert.equal(inactiveDue(mainThread(), descendants, settings), due, what);
});

void test('pending reads the D6 restore and never counts an archived Thread', () => {
  assert.equal(pending(child()), false, 'an idle finished child');
  assert.equal(
    pending(child({ result: undefined }, { restoredAt: at(4 * hour) })),
    true,
    'restored, no result',
  );
  assert.equal(
    pending(child({}, { restoredAt: at(3 * hour) })),
    true,
    'restored at the result time',
  );
  assert.equal(
    pending(child({}, { restoredAt: at(3 * hour - 1) })),
    false,
    'a turn ended after the restore',
  );
  assert.equal(
    pending(
      child(
        { ...archived, state: 'failed', result: result(hour, 'failed') },
        batchOf,
      ),
    ),
    false,
    'an archived failed Thread',
  );
});

// T-3 ---------------------------------------------------------------------

void test('manualArchiveSet refuses an archived target and a busy one', () => {
  assert.equal(
    manualArchiveSet(mainThread(archived, batchOf), [child()]),
    'already_archived',
  );
  assert.equal(
    manualArchiveSet(mainThread({}, { busy: true }), [child()]),
    'busy',
  );
});

void test('manualArchiveSet takes the target first and every idle unpinned descendant, failed and cancelled included', () => {
  const target = mainThread();
  const idle = child();
  const busy = child({ state: 'running' }, { busy: true });
  const underBusy = child({ parentThreadId: busy.thread.id });
  const pinned = child({ pinned: true });
  const underPinned = child({ parentThreadId: pinned.thread.id });
  const failed = child({ state: 'failed', result: result(hour, 'failed') });
  const cancelled = child({ state: 'cancelled' });
  const already = child(archived, batchOf);
  const answer = manualArchiveSet(target, [
    idle,
    busy,
    underBusy,
    pinned,
    underPinned,
    failed,
    cancelled,
    already,
  ]);
  assert.ok(Array.isArray(answer), `answered ${String(answer)}`);
  const [first, ...rest] = answer as readonly string[];
  assert.equal(first, target.thread.id);
  assert.deepEqual(
    [...rest].sort(),
    [
      idle.thread.id,
      underBusy.thread.id,
      underPinned.thread.id,
      failed.thread.id,
      cancelled.thread.id,
    ].sort(),
  );
});

// T-4 ---------------------------------------------------------------------

void test('restoreSet restores the target and every descendant of its own batch', () => {
  const batch = randomUUID();
  const target = mainThread(archived, { batch });
  const same = child(archived, { batch });
  const other = child(archived, { batch: randomUUID() });
  const open = child();
  const answer = restoreSet(target, [same, other, open]);
  assert.equal(answer[0], target.thread.id);
  assert.deepEqual(
    [...answer].sort(),
    [target.thread.id, same.thread.id].sort(),
  );
});

void test('restoreSet with an explicit batch restores only the Threads carrying it', () => {
  const batch = randomUUID();
  const carrying = child(archived, { batch });
  const other = child(archived, { batch: randomUUID() });
  assert.deepEqual(restoreSet(mainThread(), [carrying, other], batch), [
    carrying.thread.id,
  ]);
  assert.deepEqual(
    restoreSet(
      mainThread(archived, { batch: randomUUID() }),
      [carrying],
      batch,
    ),
    [carrying.thread.id],
    'the target of another batch stays archived',
  );
});

void test('restoreSet answers empty without an applicable batch', () => {
  assert.deepEqual(
    restoreSet(mainThread(), [child(archived, { batch: randomUUID() })]),
    [],
  );
  assert.deepEqual(
    restoreSet(mainThread(), [child()], randomUUID()),
    [],
    'a batch nothing carries',
  );
});
