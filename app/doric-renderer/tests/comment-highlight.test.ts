import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  commentHighlightName,
  commentHighlights,
  commentHighlightsIn,
  type HighlightRegistry,
  keyedRanges,
} from '../src/chat/comment-highlight';

/** Stands in for a DOM range, which the bookkeeping only passes along. */
type FakeRange = { readonly text: string };

const fakeRanges = (...texts: string[]): readonly FakeRange[] =>
  texts.map((text) => ({ text }));

/** The registry is typed for DOM ranges, so the tests publish their stand-ins. */
const asDomRanges = (ranges: readonly FakeRange[]): readonly Range[] =>
  ranges as unknown as readonly Range[];

/** The excerpts in a list of ranges, sorted so no test depends on merge order. */
const excerpts = (ranges: readonly FakeRange[]): readonly string[] =>
  ranges.map((range) => range.text).sort();

/** A document's identity: the effect keys the registry by its editor instance. */
const editor = (): object => ({});

/** Records every merge a keyed registry publishes. */
const recordingPublish = () => {
  const merges: (readonly FakeRange[])[] = [];
  return {
    /** The ranges the registry published most recently. */
    latest: (): readonly FakeRange[] => merges.at(-1) ?? [],
    publish: (ranges: readonly FakeRange[]): void => {
      merges.push(ranges);
    },
  };
};

/**
 * The platform `Highlight`, which collects its ranges through the constructor
 * or through `add`; either way the published ranges are the same.
 */
class FakeHighlight {
  readonly ranges: FakeRange[] = [];

  constructor(...initial: FakeRange[]) {
    this.ranges.push(...initial);
  }

  add(range: FakeRange): void {
    this.ranges.push(range);
  }
}

/** The platform's Custom Highlight registry, recording what each name holds. */
const fakeHighlightRegistry = (): HighlightRegistry & {
  readonly published: Map<string, readonly FakeRange[]>;
} => {
  const published = new Map<string, readonly FakeRange[]>();
  return {
    published,
    set: (name, highlight) => {
      // The module built this with the `Highlight` this test installed.
      published.set(name, (highlight as unknown as FakeHighlight).ranges);
    },
    delete: (name) => {
      published.delete(name);
    },
  };
};

/** The excerpts published under the one styled name. */
const styled = (registry: ReturnType<typeof fakeHighlightRegistry>) =>
  excerpts(registry.published.get(commentHighlightName) ?? []);

const globals = globalThis as unknown as Record<string, unknown>;

describe('keyed ranges', () => {
  test('merges the ranges every key contributes into one list', () => {
    const { latest, publish } = recordingPublish();
    const registry = keyedRanges<string, FakeRange>(publish);

    registry.set('first', fakeRanges('one', 'two'));
    registry.set('second', fakeRanges('three'));

    assert.deepEqual(excerpts(latest()), ['one', 'three', 'two']);
    assert.deepEqual(excerpts(registry.current()), ['one', 'three', 'two']);
  });

  test('replaces the ranges a key publishes again', () => {
    const { latest, publish } = recordingPublish();
    const registry = keyedRanges<string, FakeRange>(publish);

    registry.set('first', fakeRanges('one'));
    registry.set('second', fakeRanges('two'));
    registry.set('first', fakeRanges('three'));

    assert.deepEqual(excerpts(latest()), ['three', 'two']);
    assert.deepEqual(excerpts(registry.current()), ['three', 'two']);
  });

  test('drops only the ranges of the key that cleared', () => {
    const { latest, publish } = recordingPublish();
    const registry = keyedRanges<string, FakeRange>(publish);

    registry.set('first', fakeRanges('one'));
    registry.set('second', fakeRanges('two'));
    registry.clear('first');

    assert.deepEqual(excerpts(latest()), ['two']);
    assert.deepEqual(excerpts(registry.current()), ['two']);
  });

  test('publishes an empty list once the last key clears', () => {
    const { latest, publish } = recordingPublish();
    const registry = keyedRanges<string, FakeRange>(publish);

    registry.set('only', fakeRanges('one'));
    registry.clear('only');

    assert.deepEqual(latest(), []);
    assert.deepEqual(registry.current(), []);
  });

  test('leaves the ranges alone when an unknown key clears', () => {
    const { latest, publish } = recordingPublish();
    const registry = keyedRanges<string, FakeRange>(publish);

    registry.set('only', fakeRanges('one'));
    registry.clear('never-registered');

    assert.deepEqual(excerpts(latest()), ['one']);
    assert.deepEqual(excerpts(registry.current()), ['one']);
  });
});

describe('published highlight', () => {
  // The module builds its highlight with the platform constructor, which a
  // runtime without the DOM does not have.
  let previousHighlight: unknown;

  before(() => {
    previousHighlight = globals.Highlight;
    globals.Highlight = FakeHighlight;
  });

  after(() => {
    if (previousHighlight === undefined) delete globals.Highlight;
    else globals.Highlight = previousHighlight;
  });

  test('publishes every mounted document under the one styled name', () => {
    const registry = fakeHighlightRegistry();
    const highlights = commentHighlightsIn(registry);
    const first = editor();
    const second = editor();

    highlights.set(first, asDomRanges(fakeRanges('one', 'two')));
    highlights.set(second, asDomRanges(fakeRanges('three')));

    assert.deepEqual([...registry.published.keys()], [commentHighlightName]);
    assert.deepEqual(styled(registry), ['one', 'three', 'two']);
  });

  test('removes the name once the last document unmounts', () => {
    const registry = fakeHighlightRegistry();
    const highlights = commentHighlightsIn(registry);
    const first = editor();
    const second = editor();

    highlights.set(first, asDomRanges(fakeRanges('one')));
    highlights.set(second, asDomRanges(fakeRanges('two')));
    highlights.clear(first);

    assert.deepEqual(styled(registry), ['two']);

    highlights.clear(second);

    assert.deepEqual([...registry.published.keys()], []);
  });

  test('publishes nothing when the runtime cannot register highlights', () => {
    const previous = globals.CSS;
    try {
      for (const runtimeCss of [{}, { highlights: {} }]) {
        globals.CSS = runtimeCss;
        assert.equal(commentHighlights(), undefined);
      }
    } finally {
      if (previous === undefined) delete globals.CSS;
      else globals.CSS = previous;
    }
  });
});

test('keeps the published name equal to the name the shell styles', () => {
  // The compiled test sits in `dist-tests/tests`, beside the `src` it reads.
  const shell = readFileSync(
    join(__dirname, '..', '..', 'src', 'index.html'),
    'utf8',
  );
  assert.equal(/::highlight\(([^)]+)\)/.exec(shell)?.[1], commentHighlightName);
});
