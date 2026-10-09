import assert from 'node:assert/strict';
import test from 'node:test';

import { isContractError } from 'bundle/contracts';

import {
  compareBytes,
  compareIds,
  decodeIndexKey,
  encodeIndexKey,
  type IndexScalar,
  indexValues,
  keyBounds,
  toJsonPointer,
} from '../src/index.js';
import { random } from './support/random.js';

// The order every backend must share (storage.md, decision S-11), stated
// independently of the encoding: null < false < true < numbers < strings,
// numbers numerically, strings bytewise in UTF-8, shorter tuple first on a tie.
const rank = (value: IndexScalar): number =>
  value === null
    ? 0
    : value === false
      ? 1
      : value === true
        ? 2
        : typeof value === 'number'
          ? 3
          : 4;

const compareScalar = (left: IndexScalar, right: IndexScalar): number => {
  const byRank = rank(left) - rank(right);

  if (byRank !== 0) {
    return byRank;
  }

  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1;
  }

  if (typeof left === 'string' && typeof right === 'string') {
    return Buffer.compare(
      Buffer.from(left, 'utf8'),
      Buffer.from(right, 'utf8'),
    );
  }

  return 0;
};

const compareTuple = (
  left: readonly IndexScalar[],
  right: readonly IndexScalar[],
): number => {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = compareScalar(
      left[index] as IndexScalar,
      right[index] as IndexScalar,
    );

    if (difference !== 0) {
      return difference;
    }
  }

  return left.length - right.length;
};

const sign = (value: number): number => Math.sign(value) + 0;

const isCode = (code: string) => (error: unknown) =>
  isContractError(error) && error.code === code;

const strings = [
  '',
  'a',
  'B',
  'é',
  'ab',
  'a\u0000',
  'a\u0000b',
  '\u0000',
  'z',
  '',
  '￿',
  '😀',
  'a😀',
  'Zürich',
];

const numbers = [
  -Number.MAX_VALUE,
  -1e21,
  -2,
  -1.5,
  -1,
  -Number.MIN_VALUE,
  0,
  Number.MIN_VALUE,
  0.1,
  1,
  1.5,
  2,
  2 ** 53,
  1e21,
  Number.MAX_VALUE,
];

const scalarFrom = (next: () => number): IndexScalar => {
  const pick = next();

  if (pick < 0.1) {
    return null;
  }

  if (pick < 0.2) {
    return pick < 0.15;
  }

  if (pick < 0.55) {
    return next() < 0.5
      ? (numbers[Math.floor(next() * numbers.length)] as number)
      : (next() - 0.5) * 10 ** Math.floor(next() * 12);
  }

  return next() < 0.6
    ? (strings[Math.floor(next() * strings.length)] as string)
    : Array.from({ length: Math.floor(next() * 4) }, () =>
        String.fromCodePoint(
          [0, 0x41, 0x61, 0xe9, 0xe000, 0xffff, 0x1f600][
            Math.floor(next() * 7)
          ] as number,
        ),
      ).join('');
};

const tupleFrom = (next: () => number, maxLength = 3): IndexScalar[] =>
  Array.from({ length: Math.floor(next() * (maxLength + 1)) }, () =>
    scalarFrom(next),
  );

void test('random tuples sort the same by their encoded keys and by their values', () => {
  const next = random(0x5eed);

  for (let round = 0; round < 50; round += 1) {
    const tuples = Array.from({ length: 40 }, () => tupleFrom(next));
    const byValue = [...tuples].sort(compareTuple);
    const byKey = [...tuples].sort((left, right) =>
      compareBytes(encodeIndexKey(left), encodeIndexKey(right)),
    );

    // Equal tuples may swap places; compare the orders by value.
    for (let index = 0; index < tuples.length; index += 1) {
      assert.equal(
        compareTuple(
          byKey[index] as IndexScalar[],
          byValue[index] as IndexScalar[],
        ),
        0,
      );
    }
  }
});

void test('two tuples compare by key exactly as they compare by value', () => {
  const next = random(0xc0ffee);

  for (let round = 0; round < 3000; round += 1) {
    const left = tupleFrom(next);
    const right =
      next() < 0.3 ? [...left, ...tupleFrom(next, 1)] : tupleFrom(next);

    assert.equal(
      sign(compareBytes(encodeIndexKey(left), encodeIndexKey(right))),
      sign(compareTuple(left, right)),
      `${JSON.stringify(left)} vs ${JSON.stringify(right)}`,
    );
  }
});

void test('a decoded key gives back the encoded tuple', () => {
  const next = random(42);

  for (let round = 0; round < 2000; round += 1) {
    const tuple = tupleFrom(next, 4);

    assert.deepEqual(decodeIndexKey(encodeIndexKey(tuple)), tuple);
  }
});

void test('the documented cross-type and string orders hold', () => {
  const ordered: IndexScalar[] = [
    null,
    false,
    true,
    -1,
    0,
    0.5,
    '',
    'B',
    'a',
    'a\u0000',
    'ab',
    'é',
    '￿',
    '😀',
  ];

  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(
      compareBytes(
        encodeIndexKey([ordered[index - 1] as IndexScalar]),
        encodeIndexKey([ordered[index] as IndexScalar]),
      ) < 0,
      `${JSON.stringify(ordered[index - 1])} < ${JSON.stringify(ordered[index])}`,
    );
  }
});

void test('-0 and 0 are the same JSON number and get the same key', () => {
  assert.equal(compareBytes(encodeIndexKey([-0]), encodeIndexKey([0])), 0);
});

void test('a tuple key is a prefix of the keys of the longer tuples that extend it', () => {
  const prefix = encodeIndexKey(['project-1']);
  const longer = encodeIndexKey(['project-1', '2026-10-09T00:00:00.000Z']);

  assert.deepEqual(longer.slice(0, prefix.length), prefix);
});

void test('document IDs break ties bytewise in UTF-8', () => {
  assert.ok(compareIds('B', 'a') < 0);
  assert.ok(compareIds('a', 'é') < 0);
  // UTF-16 code units would put U+FFFF after the surrogate pair of U+1F600.
  assert.ok(compareIds('￿', '😀') < 0);
  assert.equal(compareIds('same', 'same'), 0);
});

void test('values no backend can order are invalid_index_value', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -Infinity]) {
    assert.throws(() => encodeIndexKey([value]), isCode('invalid_index_value'));
  }

  for (const value of ['\uD800', 'a\uDC00', '\uDC00\uD800']) {
    assert.throws(() => encodeIndexKey([value]), isCode('invalid_index_value'));
  }

  assert.throws(
    () => encodeIndexKey([{} as unknown as IndexScalar]),
    isCode('invalid_index_value'),
  );
});

void test('a byte string the encoding never produces does not decode', () => {
  for (const bytes of [
    [0x09],
    [0x04, 0x80],
    [0x05, 0x61],
    [0x05, 0x00, 0x02],
  ]) {
    assert.throws(
      () => decodeIndexKey(Uint8Array.from(bytes)),
      isCode('invalid_input'),
    );
  }
});

void test('index fields become JSON Pointers', () => {
  assert.equal(toJsonPointer('projectId'), '/projectId');
  assert.equal(toJsonPointer('a.b'), '/a/b');
  assert.equal(toJsonPointer('a~b.c/d'), '/a~0b/c~1d');
});

void test('index values come from field paths, and a missing path is null', () => {
  const value = {
    projectId: 'p1',
    parentThreadId: null,
    meta: { createdAt: '2026-10-09', rank: 3, done: false, 'a/b': 'slash' },
    list: ['zero', 'one'],
  };

  assert.deepEqual(
    indexValues(value, [
      'projectId',
      'parentThreadId',
      'meta.createdAt',
      'meta.rank',
      'meta.done',
      'missing',
      'meta.missing.deeper',
      'projectId.length',
      'list.1',
      'meta.a/b',
    ]),
    ['p1', null, '2026-10-09', 3, false, null, null, null, 'one', 'slash'],
  );
  assert.deepEqual(indexValues('not an object', ['a']), [null]);
});

void test('an index field that holds an object or an array is invalid_index_value', () => {
  assert.throws(
    () => indexValues({ meta: { a: 1 } }, ['meta']),
    isCode('invalid_index_value'),
  );
  assert.throws(
    () => indexValues({ tags: ['x'] }, ['tags']),
    isCode('invalid_index_value'),
  );
});

type Lower = { gt: IndexScalar } | { gte: IndexScalar } | Record<never, never>;
type Upper = { lt: IndexScalar } | { lte: IndexScalar } | Record<never, never>;

const selects = (
  tuple: readonly IndexScalar[],
  equals: readonly IndexScalar[],
  range: Lower & Upper,
): boolean => {
  if (
    equals.some(
      (value, index) => compareScalar(tuple[index] as IndexScalar, value) !== 0,
    )
  ) {
    return false;
  }

  const next = tuple[equals.length] as IndexScalar;
  const bounds = range as {
    gt?: IndexScalar;
    gte?: IndexScalar;
    lt?: IndexScalar;
    lte?: IndexScalar;
  };

  return (
    (bounds.gt === undefined || compareScalar(next, bounds.gt) > 0) &&
    (bounds.gte === undefined || compareScalar(next, bounds.gte) >= 0) &&
    (bounds.lt === undefined || compareScalar(next, bounds.lt) < 0) &&
    (bounds.lte === undefined || compareScalar(next, bounds.lte) <= 0)
  );
};

void test('key bounds select exactly the tuples the equality and range select', () => {
  const next = random(0xb0b);

  for (let round = 0; round < 400; round += 1) {
    // Every stored key has three fields, as one declared index would.
    const tuples = Array.from({ length: 30 }, () =>
      Array.from({ length: 3 }, () => scalarFrom(next)),
    );
    const sample = tuples[Math.floor(next() * tuples.length)] as IndexScalar[];
    const equals = sample.slice(0, Math.floor(next() * 3));
    const pick = () =>
      next() < 0.5 ? (sample[equals.length] as IndexScalar) : scalarFrom(next);
    const lowerPick = next();
    const upperPick = next();
    const lower: Lower =
      lowerPick < 0.33
        ? { gt: pick() }
        : lowerPick < 0.66
          ? { gte: pick() }
          : {};
    const upper: Upper =
      upperPick < 0.33
        ? { lt: pick() }
        : upperPick < 0.66
          ? { lte: pick() }
          : {};
    const range = { ...lower, ...upper };
    const hasRange = Object.keys(range).length > 0;
    const { lower: from, upper: to } = keyBounds({
      equals,
      ...(hasRange ? { range } : {}),
    });

    for (const tuple of tuples) {
      const key = encodeIndexKey(tuple);

      assert.equal(
        compareBytes(key, from) >= 0 && compareBytes(key, to) < 0,
        selects(tuple, equals, range),
        `${JSON.stringify(tuple)} for ${JSON.stringify({ equals, range })}`,
      );
    }
  }
});

void test('a range takes one lower and one upper bound at most', () => {
  assert.throws(
    () => keyBounds({ equals: [], range: { gt: 1, gte: 1 } }),
    isCode('invalid_input'),
  );
  assert.throws(
    () => keyBounds({ equals: [], range: { lt: 1, lte: 1 } }),
    isCode('invalid_input'),
  );
});
