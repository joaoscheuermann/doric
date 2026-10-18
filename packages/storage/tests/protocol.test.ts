import assert from 'node:assert/strict';
import test from 'node:test';

import { type CommitBatch, isContractError } from 'bundle/contracts';

import {
  batchSize,
  checkBatchLimits,
  decodeCursor,
  defaultStorageCapabilities,
  encodeCursor,
  jsonBytes,
  limitExceeded,
  parseStreamId,
  revisionConflict,
  sequenceConflict,
  streamIdPattern,
  uniqueConflict,
} from '../src/index.js';

const isCode = (code: string, details?: unknown) => (error: unknown) => {
  assert.ok(isContractError(error), String(error));
  assert.equal(error.code, code);

  if (details !== undefined) {
    assert.deepEqual(error.details, details);
  }

  return true;
};

void test('a cursor gives back the position it was made from', () => {
  const positions = [
    { key: Uint8Array.from([]), id: '' },
    { key: Uint8Array.from([0x00, 0xff, 0x05, 0x61, 0x00, 0x01]), id: 'doc-1' },
    { key: Uint8Array.from([0xfe, 0xff, 0xff]), id: 'é/😀 with spaces' },
  ];

  for (const position of positions) {
    const cursor = encodeCursor(position);

    assert.match(cursor, /^[A-Za-z0-9_-]*$/);
    assert.deepEqual(decodeCursor(cursor), position);
  }
});

void test('a cursor the backend did not write is invalid_input', () => {
  const notJson = Buffer.from('not json').toString('base64url');
  const wrongShape = Buffer.from(JSON.stringify({ k: 1, i: 'x' })).toString(
    'base64url',
  );
  const badKey = Buffer.from(JSON.stringify({ k: '+/=', i: 'x' })).toString(
    'base64url',
  );

  for (const cursor of ['%%%', 'a b', notJson, wrongShape, badKey]) {
    assert.throws(() => decodeCursor(cursor), isCode('invalid_input'));
  }
});

void test('a stream ID names its owner, family and key', () => {
  assert.deepEqual(parseStreamId('runtime.thread.events/thread-1'), {
    owner: 'runtime',
    family: 'runtime.thread.events',
    key: 'thread-1',
  });
  assert.deepEqual(parseStreamId('my-bundle.log/a/b:c'), {
    owner: 'my-bundle',
    family: 'my-bundle.log',
    key: 'a/b:c',
  });
});

void test('a stream ID outside <owner>.<family>/<key> is invalid_stream', () => {
  for (const id of [
    'runtime/thread-1',
    'Runtime.thread/1',
    'runtime.thread/',
    'runtime.thread/a b',
    'runtime.thread',
    '1runtime.thread/1',
    'runtime..thread/1',
  ]) {
    assert.equal(streamIdPattern.test(id), false, id);
    assert.throws(
      () => parseStreamId(id),
      isCode('invalid_stream', { stream: id }),
    );
  }
});

void test('conflict and limit errors carry their code and details', () => {
  assert.throws(
    () => {
      throw revisionConflict({ type: 'runtime.thread/v1', id: 't1' }, 7, 8);
    },
    isCode('revision_conflict', {
      type: 'runtime.thread/v1',
      id: 't1',
      expected: 7,
      actual: 8,
    }),
  );
  assert.throws(
    () => {
      throw sequenceConflict('runtime.thread.events/t1', 41, 42);
    },
    isCode('sequence_conflict', {
      stream: 'runtime.thread.events/t1',
      expected: 41,
      actual: 42,
    }),
  );
  assert.throws(
    () => {
      throw uniqueConflict('runtime.thread/v1', 'byName');
    },
    isCode('unique_conflict', { type: 'runtime.thread/v1', index: 'byName' }),
  );
  assert.throws(
    () => {
      throw limitExceeded('document', 10);
    },
    isCode('limit_exceeded', { what: 'document', limit: 10 }),
  );
});

const key = { type: 'runtime.thread/v1', id: 't1' };

void test('a batch counts every expect, put, delete, dropped stream, truncate and appended event', () => {
  assert.equal(batchSize({}), 0);
  assert.equal(
    batchSize({
      expect: [{ ...key, revision: 1 }],
      put: [
        { ...key, value: {} },
        { ...key, value: {} },
      ],
      delete: [key],
      dropStreams: ['runtime.thread.events/a', 'runtime.thread.events/b'],
      truncate: { stream: 'runtime.thread.events/t1', afterSequence: 0 },
      append: [
        { stream: 'runtime.thread.events/t1', events: [1, 2, 3] },
        { stream: 'runtime.thread.events/t2', events: [4] },
      ],
    }),
    1 + 2 + 1 + 2 + 1 + 4,
  );
});

void test('JSON size is the UTF-8 byte length of the JSON text', () => {
  assert.equal(jsonBytes('é'), 4);
  assert.equal(jsonBytes({ a: 1 }), 7);
  assert.equal(jsonBytes(undefined), 4);
});

void test('the default limits are positive and fit a large atomic deletion', () => {
  assert.ok(defaultStorageCapabilities.maxBatch >= 10_000);
  assert.ok(defaultStorageCapabilities.maxDocumentBytes > 0);
  assert.ok(defaultStorageCapabilities.maxAppendBytes > 0);
});

void test('an empty batch is invalid_input', () => {
  assert.throws(
    () => checkBatchLimits({}, defaultStorageCapabilities),
    isCode('invalid_input'),
  );
  assert.throws(
    () => checkBatchLimits({ put: [], append: [] }, defaultStorageCapabilities),
    isCode('invalid_input'),
  );
});

void test('limits are inclusive: at the limit passes, one over is limit_exceeded', () => {
  const limits = { maxBatch: 2, maxDocumentBytes: 7, maxAppendBytes: 4 };
  const puts = (count: number): CommitBatch => ({
    put: Array.from({ length: count }, (_, index) => ({
      type: 'a.b/v1',
      id: String(index),
      value: 1,
    })),
  });

  checkBatchLimits(puts(2), limits);
  assert.throws(
    () => checkBatchLimits(puts(3), limits),
    isCode('limit_exceeded', { what: 'batch', limit: 2 }),
  );

  checkBatchLimits({ put: [{ ...key, value: { a: 1 } }] }, limits);
  assert.throws(
    () => checkBatchLimits({ put: [{ ...key, value: { a: 12 } }] }, limits),
    isCode('limit_exceeded', { what: 'document', limit: 7 }),
  );

  checkBatchLimits({ append: [{ stream: 's.t/1', events: ['ab'] }] }, limits);
  assert.throws(
    () =>
      checkBatchLimits(
        { append: [{ stream: 's.t/1', events: ['abc'] }] },
        limits,
      ),
    isCode('limit_exceeded', { what: 'append', limit: 4 }),
  );
});
