import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { ThreadEvent } from '../../src/contracts/model.js';
import type { PromptProgress } from '../../src/host/store/index.js';
import { memoryBackend, snapshot, stores } from './support.js';

/*
 * The `pending` projection folded one append at a time equals the former
 * full read of the log (design 57 §3.5, risk R5). The oracle below is the
 * former `unfinishedPrompts` of agents/doric/src/lib/workspace/threads.ts,
 * kept verbatim over the events the store answers; the store is checked
 * both with its incremental projection and with the projection removed
 * (a document the stage-7 import wrote, folded lazily from the stream).
 */

type Progress = {
  -readonly [Key in keyof PromptProgress]: PromptProgress[Key];
};

const pauseReasons = [
  'storage_low',
  'host_stopped',
  'host_restarted',
  'reader_stopped',
];

const progressTypes = [
  'prompt.accepted',
  'prompt.edited',
  'prompt.started',
  'prompt.finished',
  'prompt.paused',
  'prompt.resumed',
  'agent.started',
];

/** The former fold, over rows in (sequence, threadId) order. */
const oracle = (
  projectId: string,
  rows: readonly ThreadEvent[],
): PromptProgress[] => {
  const pending = new Map<string, Progress>();
  for (const row of rows) {
    if (!progressTypes.includes(row.type)) continue;
    const key = `${row.threadId}:${row.promptId}`;
    if (row.type === 'prompt.accepted') {
      if (pending.has(key)) continue;
      const accepted = row.event as {
        readonly text?: string;
        readonly source?: PromptProgress['source'];
        readonly queued?: boolean;
      } | null;
      if (
        accepted?.queued !== true &&
        (accepted?.source === undefined || accepted.source.kind === 'user')
      ) {
        for (const previous of pending.values()) {
          if (
            previous.threadId === row.threadId &&
            previous.paused !== undefined
          )
            previous.superseded = true;
        }
      }
      pending.set(key, {
        projectId,
        threadId: row.threadId,
        promptId: row.promptId,
        text: accepted?.text ?? '',
        revision: row.sequence,
        source: accepted?.source ?? { kind: 'user' },
        started: false,
        attempts: 0,
        acceptedAt: row.createdAt,
        queuedSequence: row.sequence,
      });
      continue;
    }
    const progress = pending.get(key);
    if (progress === undefined) continue;
    if (row.type === 'prompt.finished') pending.delete(key);
    else if (row.type === 'agent.started' || row.type === 'prompt.started')
      progress.started = true;
    else if (row.type === 'prompt.edited') {
      const text = (row.event as { text?: unknown } | null)?.text;
      if (typeof text === 'string') {
        progress.text = text;
        progress.revision = row.sequence;
      }
    } else if (row.type === 'prompt.resumed') {
      progress.attempts += 1;
      progress.paused = undefined;
      progress.queuedSequence = row.sequence;
      progress.first =
        (row.event as { first?: boolean } | null)?.first === true;
    } else {
      const reason = (row.event as { readonly reason?: unknown } | null)
        ?.reason;
      if (pauseReasons.includes(reason as string)) {
        progress.paused = reason as Progress['paused'];
        progress.pausedSequence = row.sequence;
      }
    }
  }
  // The former objects kept `paused: undefined` after a resume; the
  // projection omits an absent field.
  return [...pending.values()].map(
    (progress) =>
      Object.fromEntries(
        Object.entries(progress).filter(([, value]) => value !== undefined),
      ) as unknown as PromptProgress,
  );
};

/** A small seeded generator, so a failure reproduces. */
const random = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
};

const pick = <T>(next: () => number, values: readonly T[]): T =>
  values[Math.floor(next() * values.length)] as T;

const sources = (parent: string) => [
  undefined,
  { kind: 'user' },
  { kind: 'parent', threadId: parent, promptId: randomUUID() },
  { kind: 'terminal', terminalId: 't1', promptId: randomUUID() },
  {
    kind: 'result',
    threadId: parent,
    promptId: randomUUID(),
    requestPromptId: randomUUID(),
  },
];

const generated = (
  next: () => number,
  prompts: readonly string[],
  parent: string,
) => {
  const type = pick(next, [
    ...progressTypes,
    ...progressTypes,
    'text.delta',
    'queue.updated',
    'prompt.queued',
  ]);
  const event: Record<string, unknown> = { type };
  if (type === 'prompt.accepted') {
    if (next() < 0.8) event.text = `input ${Math.floor(next() * 100)}`;
    const source = pick(next, sources(parent));
    if (source !== undefined) event.source = source;
    if (next() < 0.5) event.queued = true;
  } else if (type === 'prompt.edited') {
    if (next() < 0.8) event.text = `edit ${Math.floor(next() * 100)}`;
  } else if (type === 'prompt.paused') {
    event.reason = pick(next, [...pauseReasons, 'other']);
  } else if (type === 'prompt.resumed') {
    if (next() < 0.5) event.first = next() < 0.5;
  }
  return { promptId: pick(next, prompts), event };
};

const compare = async (
  seed: number,
  entries: readonly { readonly promptId: string; readonly event: unknown }[],
  batches: (next: () => number) => number,
) => {
  const backend = memoryBackend();
  try {
    const { projects, threads } = stores(backend.storage);
    const { project } = await projects.create('Fold', snapshot(), 'blue');
    const { thread } = await threads.create(project.id, 'Thread');
    const next = random(seed);
    // One appendEvents call commits consecutive events of one prompt.
    for (let index = 0; index < entries.length; ) {
      const promptId = entries[index]?.promptId as string;
      const limit = index + batches(next);
      let end = index + 1;
      while (
        end < entries.length &&
        end < limit &&
        entries[end]?.promptId === promptId
      )
        end += 1;
      await threads.appendEvents(
        thread.id,
        promptId,
        entries.slice(index, end).map(({ event }) => event),
      );
      index = end;
    }
    const log = await threads.eventsAfter(thread.id, 0);
    const expected = oracle(project.id, log);
    const incremental = await threads.unfinishedPrompts(thread.id);
    assert.deepEqual(incremental, expected, `seed ${seed}: incremental`);
    // The same Thread as the stage-7 import writes it: no projection.
    const stored = await backend.storage.get({
      type: 'runtime.thread/v1',
      id: thread.id,
    });
    assert.ok(stored);
    await backend.storage.commit({
      expect: [
        { type: 'runtime.thread/v1', id: thread.id, revision: stored.revision },
      ],
      put: [
        {
          type: 'runtime.thread/v1',
          id: thread.id,
          value: { ...(stored.value as object), pending: null },
        },
      ],
    });
    const lazy = stores(backend.second()).threads;
    assert.deepEqual(
      await lazy.unfinishedPrompts(thread.id),
      expected,
      `seed ${seed}: full fold`,
    );
    // An append onto the lazy document materializes the same projection.
    const extra = randomUUID();
    await lazy.appendEvent(thread.id, extra, {
      type: 'prompt.accepted',
      text: 'after',
      queued: true,
    });
    assert.deepEqual(
      await lazy.unfinishedPrompts(thread.id),
      oracle(project.id, await lazy.eventsAfter(thread.id, 0)),
      `seed ${seed}: after materializing`,
    );
  } finally {
    await backend.close();
  }
};

void test('the incremental projection equals the full fold over generated logs', async () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    const next = random(seed * 7919);
    const prompts = Array.from({ length: 1 + Math.floor(next() * 4) }, () =>
      randomUUID(),
    );
    const parent = randomUUID();
    const entries = Array.from({ length: 5 + Math.floor(next() * 40) }, () =>
      generated(next, prompts, parent),
    );
    await compare(seed, entries, (draw) => 1 + Math.floor(draw() * 3));
  }
});

void test('the incremental projection equals the full fold over the baseline E2E log', async () => {
  const fixture = JSON.parse(
    await readFile(
      'bundles/runtime/runtime/tests/store/fixtures/baseline-logs.json',
      'utf8',
    ),
  ) as {
    logs: {
      entries: { promptId: string; type: string; event: unknown }[];
    }[];
  };
  assert.ok(fixture.logs.length > 0);
  for (const [index, log] of fixture.logs.entries()) {
    // The normalized placeholders stand for real prompt ids.
    const ids = new Map<string, string>();
    const idOf = (placeholder: string) => {
      const id = ids.get(placeholder) ?? randomUUID();
      ids.set(placeholder, id);
      return id;
    };
    await compare(
      index + 1,
      log.entries.map(({ promptId, event }) => ({
        promptId: idOf(promptId),
        event,
      })),
      () => 1,
    );
  }
});
