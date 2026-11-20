// How the Files tree merges the answers of the providers of
// `files.decorations/v1` (bundle isolation 9, T9.1, plan cases 6–8):
// - for a path two providers mark, the mark of the provider whose bundle id is
//   smaller, compared by code unit (so `Zed` comes before `alpha`), is drawn,
//   whatever order the answers arrive in;
// - the error shown is the first in bundle-id order, and the tree is
//   refreshing while any provider is fetching;
// - answers whose mark lists are the ones merged before give back the merge
//   before, so the rows keep their identity.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  mergeDecorations,
  type ProviderMarks,
} from '../src/client/tree/decorations.js';
import type {
  DecorationsObservation,
  FileMark,
} from '../src/contracts/index.js';

const mark = (description: string, letter?: string): FileMark => ({
  description,
  count: 1,
  ...(letter === undefined ? {} : { letter }),
});

const answer = (
  bundleId: string,
  observation: Partial<DecorationsObservation> = {},
): ProviderMarks => ({
  bundleId,
  observation: { marks: [], fetching: false, ...observation },
});

describe('mergeDecorations', () => {
  test('draws the mark of the provider whose bundle id is smaller by code unit for a path both mark', () => {
    const alpha = answer('alpha', {
      marks: [{ path: 'src/app.ts', mark: mark('From alpha', 'A') }],
    });
    const upper = answer('Zed', {
      marks: [{ path: 'src/app.ts', mark: mark('From Zed', 'Z') }],
    });

    for (const answers of [
      [alpha, upper],
      [upper, alpha],
    ]) {
      const merged = mergeDecorations(answers);
      assert.equal(merged.marks.get('src/app.ts')?.description, 'From Zed');
      assert.equal(merged.marks.size, 1);
    }
  });

  test('keeps the marks of paths only one provider marks', () => {
    const merged = mergeDecorations([
      answer('beta', { marks: [{ path: 'b.ts', mark: mark('From beta') }] }),
      answer('alpha', { marks: [{ path: 'a.ts', mark: mark('From alpha') }] }),
    ]);

    assert.equal(merged.marks.get('a.ts')?.description, 'From alpha');
    assert.equal(merged.marks.get('b.ts')?.description, 'From beta');
  });

  test('shows the first error in bundle-id order, and is fetching while any provider is', () => {
    const merged = mergeDecorations([
      answer('beta', { error: 'beta failed' }),
      answer('gamma', { fetching: true }),
      answer('alpha', { error: 'alpha failed' }),
    ]);

    assert.equal(merged.error, 'alpha failed');
    assert.equal(merged.fetching, true);
  });

  test('has no error and is not fetching when no provider fails or fetches', () => {
    const merged = mergeDecorations([answer('alpha'), answer('beta')]);

    assert.equal(merged.error, undefined);
    assert.equal(merged.fetching, false);
    assert.equal(merged.marks.size, 0);
  });

  test('gives back the merge before when no mark list changed', () => {
    const alphaMarks = [{ path: 'a.ts', mark: mark('From alpha') }];
    const betaMarks = [{ path: 'b.ts', mark: mark('From beta') }];
    const previous = mergeDecorations([
      answer('alpha', { marks: alphaMarks }),
      answer('beta', { marks: betaMarks }),
    ]);

    // New answers, each carrying the list it carried before.
    const again = mergeDecorations(
      [
        answer('alpha', { marks: alphaMarks }),
        answer('beta', { marks: betaMarks }),
      ],
      previous,
    );

    assert.equal(again, previous);
  });

  test('keeps the marks of the merge before when only a provider starts fetching', () => {
    const alphaMarks = [{ path: 'a.ts', mark: mark('From alpha') }];
    const previous = mergeDecorations([answer('alpha', { marks: alphaMarks })]);

    const fetching = mergeDecorations(
      [answer('alpha', { marks: alphaMarks, fetching: true })],
      previous,
    );

    assert.equal(fetching.marks, previous.marks);
    assert.equal(fetching.fetching, true);
  });

  test('merges again when a provider answers a new mark list', () => {
    const previous = mergeDecorations([
      answer('alpha', { marks: [{ path: 'a.ts', mark: mark('Before') }] }),
    ]);

    const next = mergeDecorations(
      [answer('alpha', { marks: [{ path: 'a.ts', mark: mark('After') }] })],
      previous,
    );

    assert.equal(next.marks.get('a.ts')?.description, 'After');
  });
});
