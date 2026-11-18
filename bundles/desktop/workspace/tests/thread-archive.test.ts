// The sidebar's two tabs over one Project's Threads
// (docs/designs/thread-archive.md §10.1, T-22): which Threads the Chat tab
// and the Archived tab draw, which are context rows, and the archive rules a
// row reads (AC15, AC16, AC19, AC23).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  archivable,
  archivedSectionOf,
  archivedSections,
  chatThreads,
  descendantsInChat,
  isArchived,
  type TabThreads,
} from '../src/client/domain/thread-archive.js';
import { filterThreadTree } from '../src/client/domain/thread-filter.js';
import { threadControl } from '../src/client/domain/thread-kind.js';
import { threadLevel } from '../src/client/domain/thread-tree.js';
import type { Thread } from '../src/client/domain/workspace.js';

const projectId = '22222222-2222-4222-8222-222222222222';

// A local clock reading, so the sections hold in every time zone. June has
// no daylight-saving change in the week before the 17th.
const local = (day: number, hour = 0, minute = 0, ms = 0): Date =>
  new Date(2026, 5, day, hour, minute, 0, ms);
const now = local(17, 15);
const today = local(17, 9).toISOString();
const thisWeek = local(13, 9).toISOString();
const older = local(1, 9).toISOString();

const thread = (
  id: string,
  options: {
    readonly parent?: string;
    readonly archivedAt?: string;
    readonly state?: Thread['state'];
    readonly origin?: 'user' | 'agent';
    readonly pinned?: boolean;
  } = {},
): Thread => ({
  id,
  projectId,
  name: id,
  state: options.state ?? 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '',
  updatedAt: '',
  ...(options.parent === undefined ? {} : { parentThreadId: options.parent }),
  ...(options.archivedAt === undefined
    ? {}
    : { archivedAt: options.archivedAt }),
  ...(options.origin === undefined ? {} : { origin: options.origin }),
  ...(options.pinned === undefined ? {} : { pinned: options.pinned }),
});

/** A tab's answer as plain ids, for one comparison. */
const shape = (tab: TabThreads) => ({
  threads: tab.threads.map(({ id }) => id),
  context: [...tab.context].sort(),
});

describe('isArchived', () => {
  test('a record with archivedAt is archived, whatever else it holds', () => {
    assert.equal(isArchived(thread('a', { archivedAt: today })), true);
    assert.equal(
      isArchived(
        thread('a', { archivedAt: today, state: 'running', pinned: true }),
      ),
      true,
    );
  });

  test('a record without archivedAt is not archived', () => {
    assert.equal(isArchived(thread('a')), false);
    assert.equal(isArchived(thread('a', { pinned: true })), false);
  });
});

describe('chatThreads: the Chat tab (U6, AC15)', () => {
  test('an archived leaf is hidden', () => {
    const tab = chatThreads([
      thread('a'),
      thread('b', { parent: 'a', archivedAt: today }),
    ]);

    assert.deepEqual(shape(tab), { threads: ['a'], context: [] });
  });

  test('an archived ancestor of a Thread in Chat is kept as context', () => {
    const tab = chatThreads([
      thread('a', { archivedAt: today }),
      thread('b', { parent: 'a', archivedAt: today }),
      thread('c', { parent: 'b' }),
    ]);

    assert.deepEqual(shape(tab), {
      threads: ['a', 'b', 'c'],
      context: ['a', 'b'],
    });
  });

  test('an archived ancestor of only archived Threads is hidden', () => {
    const tab = chatThreads([
      thread('a', { archivedAt: today }),
      thread('b', { parent: 'a', archivedAt: today }),
      thread('m'),
    ]);

    assert.deepEqual(shape(tab), { threads: ['m'], context: [] });
  });

  test('the Threads keep the input order and appear once', () => {
    const tab = chatThreads([
      thread('c', { parent: 'a' }),
      thread('a', { archivedAt: today }),
      thread('d', { parent: 'a' }),
    ]);

    assert.deepEqual(shape(tab), {
      threads: ['c', 'a', 'd'],
      context: ['a'],
    });
  });

  test('a Thread whose parent is missing is kept alone', () => {
    const tab = chatThreads([thread('c', { parent: 'gone' })]);

    assert.deepEqual(shape(tab), { threads: ['c'], context: [] });
  });

  test('an archived parent a draft names is kept as context, with its archived ancestors', () => {
    const threads = [
      thread('a', { archivedAt: today }),
      thread('b', { parent: 'a', archivedAt: today }),
      thread('m'),
    ];

    assert.deepEqual(shape(chatThreads(threads, 'b')), {
      threads: ['a', 'b', 'm'],
      context: ['a', 'b'],
    });
  });

  test('a draft parent that is not archived adds nothing', () => {
    const threads = [thread('a'), thread('b', { archivedAt: today })];

    assert.deepEqual(shape(chatThreads(threads, 'a')), {
      threads: ['a'],
      context: [],
    });
  });
});

describe('archivedSectionOf: the section of an archive time (local dates)', () => {
  const cases: readonly [string, string, string][] = [
    ["today's local midnight", local(17).toISOString(), 'today'],
    ['one millisecond before it', local(16, 23, 59, 999).toISOString(), 'week'],
    ['the local midnight seven days before', local(10).toISOString(), 'week'],
    [
      'one millisecond before that',
      local(9, 23, 59, 999).toISOString(),
      'older',
    ],
    ['a time after now', local(18, 10).toISOString(), 'today'],
    ['a time that does not parse', 'not a date', 'older'],
  ];

  for (const [name, at, section] of cases) {
    test(`${name} is ${section}`, () => {
      assert.equal(archivedSectionOf(at, now), section);
    });
  }
});

describe('archivedSections: the Archived tab (U10, AC16)', () => {
  test('each section holds its archived Threads and their ancestors, in input order', () => {
    const threads = [
      thread('p'),
      thread('c1', { parent: 'p', archivedAt: today }),
      thread('c2', { parent: 'p', archivedAt: older }),
      thread('q', { archivedAt: thisWeek }),
      thread('q1', { parent: 'q', archivedAt: today }),
      thread('m'),
    ];

    const sections = archivedSections(threads, now);

    assert.deepEqual(
      sections.map((section) => ({
        id: section.id,
        label: section.label,
        ...shape(section),
      })),
      [
        {
          id: 'today',
          label: 'Today',
          threads: ['p', 'c1', 'q', 'q1'],
          context: ['p', 'q'],
        },
        { id: 'week', label: 'Last 7 days', threads: ['q'], context: [] },
        { id: 'older', label: 'Older', threads: ['p', 'c2'], context: ['p'] },
      ],
    );
  });

  test('an empty section is omitted', () => {
    const sections = archivedSections(
      [thread('a', { archivedAt: older }), thread('b')],
      now,
    );

    assert.deepEqual(
      sections.map((section) => ({ id: section.id, ...shape(section) })),
      [{ id: 'older', threads: ['a'], context: [] }],
    );
  });

  test('no archived Thread is no section', () => {
    assert.deepEqual(archivedSections([thread('a'), thread('b')], now), []);
  });

  test('a Thread whose parent is missing keeps no ancestors', () => {
    const sections = archivedSections(
      [thread('c', { parent: 'gone', archivedAt: today })],
      now,
    );

    assert.deepEqual(
      sections.map((section) => ({ id: section.id, ...shape(section) })),
      [{ id: 'today', threads: ['c'], context: [] }],
    );
  });
});

describe('the search over each sidebar tab keeps the context ancestors of a match', () => {
  const threads = [
    thread('root', { archivedAt: today }),
    thread('needle', { parent: 'root' }),
    thread('other'),
  ];

  test('in Chat', () => {
    const level = threadLevel(
      chatThreads(threads).threads,
      undefined,
      projectId,
    );
    const filter = filterThreadTree(level.nodes, 'needle');

    assert.deepEqual([...filter.shown].sort(), ['needle', 'root']);
    assert.deepEqual([...filter.expanded], ['root']);
  });

  test('in Archived', () => {
    const archived = [
      thread('parent'),
      thread('needle', { parent: 'parent', archivedAt: today }),
      thread('hay', { archivedAt: today }),
    ];
    const [section] = archivedSections(archived, now);
    assert.ok(section !== undefined);
    const level = threadLevel(section.threads, undefined, projectId);
    const filter = filterThreadTree(level.nodes, 'needle');

    assert.deepEqual([...filter.shown].sort(), ['needle', 'parent']);
    assert.deepEqual([...filter.expanded], ['parent']);
  });
});

describe('archivable: the rows that offer Archive', () => {
  for (const state of ['ready', 'cancelled', 'failed'] as const) {
    test(`a Thread in state ${state} is archivable`, () => {
      assert.equal(archivable(thread('a', { state })), true);
    });
  }

  for (const state of ['queued', 'running', 'cancelling'] as const) {
    test(`a Thread in state ${state} is not archivable`, () => {
      assert.equal(archivable(thread('a', { state })), false);
    });
  }

  test('an archived Thread is not archivable', () => {
    assert.equal(archivable(thread('a', { archivedAt: today })), false);
  });
});

describe('descendantsInChat: the delete dialog count (U16, AC23)', () => {
  test('a Thread without descendants has none', () => {
    assert.equal(
      descendantsInChat([thread('a', { archivedAt: today })], 'a'),
      0,
    );
  });

  test('one non-archived child is one', () => {
    assert.equal(
      descendantsInChat(
        [thread('a', { archivedAt: today }), thread('b', { parent: 'a' })],
        'a',
      ),
      1,
    );
  });

  test('every non-archived descendant counts, at any depth', () => {
    assert.equal(
      descendantsInChat(
        [
          thread('a', { archivedAt: today }),
          thread('b', { parent: 'a' }),
          thread('c', { parent: 'b' }),
          thread('d', { parent: 'a' }),
          thread('x'),
        ],
        'a',
      ),
      3,
    );
  });

  test('archived descendants are not counted', () => {
    assert.equal(
      descendantsInChat(
        [
          thread('a', { archivedAt: today }),
          thread('b', { parent: 'a', archivedAt: today }),
          thread('c', { parent: 'b' }),
        ],
        'a',
      ),
      1,
    );
  });

  test('an unknown id has none', () => {
    assert.equal(descendantsInChat([thread('a')], 'gone'), 0);
  });
});

describe('threadControl of an archived Thread (D16, U11, AC19)', () => {
  test('an archived agent thread deletes; every other field is its kind’s', () => {
    const live = thread('agent', { parent: 'p', origin: 'agent' });
    const archived = thread('agent', {
      parent: 'p',
      origin: 'agent',
      archivedAt: today,
    });

    assert.equal(threadControl(live).deletes, false);
    assert.deepEqual(threadControl(archived), {
      ...threadControl(live),
      deletes: true,
    });
  });
});
