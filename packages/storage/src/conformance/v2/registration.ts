/**
 * Registration, backfill and generations over `TestEngine.storage`
 * (T4.24). A case that registers a generation above 1 runs on
 * `V2Harness.fresh()`, since `reset()` keeps the engine's highest
 * generation; those are in `generations.ts`.
 */
import assert from 'node:assert/strict';

import type { DescFile } from '@bufbuild/protobuf';

import { conformanceFile, type MessageSpec } from './files.js';
import {
  idsOf,
  noteKey,
  notePut,
  padded,
  range,
  revisions,
  state,
  thread,
  threadIndexes,
  threadKey,
  threadPut,
  threadsWith,
} from './fixtures.js';
import { generationCases } from './generations.js';
import { caseGroup, conformanceBundle, type V2Case } from './harness.js';
import { ids, isCode, walk } from './support.js';

const registration = caseGroup('registration');

/** A message `{ text }` declaring the storage type `type`. */
const typed = (name: string, type: string): MessageSpec => ({
  name,
  fields: [{ name: 'text', kind: 'string' }],
  storageType: type,
});

/** A type id of `bytes` UTF-8 bytes in the namespace `conformance`. */
const typeOfBytes = (bytes: number): string =>
  `conformance.${'x'.repeat(bytes - 'conformance.'.length - '/v1'.length)}/v1`;

const refused: readonly (readonly [string, readonly DescFile[]])[] = [
  [
    'an index on a repeated field',
    [
      conformanceFile('tagged', [
        {
          name: 'Tagged',
          fields: [{ name: 'tags', kind: 'string', repeated: true }],
          storageType: 'conformance.tagged/v1',
          indexes: [{ name: 'byTags', fields: ['tags'] }],
        },
      ]),
    ],
  ],
  [
    'two indexes of one type with one name',
    threadsWith([
      ...threadIndexes,
      { name: 'twice', fields: ['name'] },
      { name: 'twice', fields: ['projectId'] },
    ]),
  ],
  [
    'one type declared by two messages',
    [
      conformanceFile('twins', [
        typed('One', 'conformance.twin/v1'),
        typed('Two', 'conformance.twin/v1'),
      ]),
    ],
  ],
  ['an empty type id', [conformanceFile('nameless', [typed('Nameless', '')])]],
  [
    'a type id of 129 bytes',
    [conformanceFile('long', [typed('Long', typeOfBytes(129))])],
  ],
];

const cases: readonly V2Case[] = [
  registration(
    'REG1',
    'Register refuses invalid declarations with invalid_input and writes nothing',
    async (harness) => {
      const storage = await harness.open();

      await storage.commit({ put: [notePut('n1', { title: 'kept' })] });

      const before = await state(harness);

      for (const [label, files] of refused) {
        await assert.rejects(
          harness.open(conformanceBundle, files),
          isCode('invalid_input'),
          label,
        );
        assert.deepEqual(await state(harness), before, label);
      }

      // The boundary: a type id of 128 bytes registers.
      await harness.open(conformanceBundle, [
        conformanceFile('longest', [typed('Longest', typeOfBytes(128))]),
      ]);
      assert.deepEqual(await revisions(storage, [noteKey('n1')]), [1]);
    },
  ),
  registration(
    'REG2',
    'an index with no fields registers and holds every document in id order',
    async (harness) => {
      const storage = await harness.open(
        conformanceBundle,
        threadsWith([...threadIndexes, { name: 'all', fields: [] }]),
      );

      await storage.commit({
        put: ['t3', 't1', 't2'].map((id) => threadPut(id, { projectId: id })),
      });
      assert.deepEqual(
        await idsOf(storage, { type: thread, index: 'all', equals: [] }),
        ['t1', 't2', 't3'],
      );
    },
  ),
  registration(
    'REG3',
    'empty files register, and the declarations they leave out stay',
    async (harness) => {
      const storage = await harness.open();

      await storage.commit({ put: [notePut('n1', { title: 'one' })] });
      await harness.open(conformanceBundle, []);
      await storage.commit({ put: [notePut('n2', { title: 'two' })] });
      assert.deepEqual(
        await revisions(storage, [noteKey('n1'), noteKey('n2')]),
        [1, 1],
      );
    },
  ),
  registration(
    'REG4',
    'registering the same set twice leaves the store unchanged, byte for byte',
    async (harness) => {
      const storage = await harness.open();

      await storage.commit({
        put: [
          notePut('n1', { title: 'one', tag: 't' }),
          threadPut('t1', { projectId: 'p1', name: 'x' }),
        ],
      });

      const before = await state(harness);

      await harness.open();
      assert.deepEqual(await state(harness), before);
    },
  ),
  registration(
    'REG5',
    "a new index is built for 1,000 stored documents, and a query sees them all in the index's order",
    async (harness) => {
      const storage = await harness.open();
      const count = 1000;

      // Ids ascend while `createdAt` descends, so the order is the index's.
      await storage.commit({
        put: range(count).map((index) =>
          threadPut(`t${padded(index)}`, {
            projectId: 'p1',
            createdAt: `c${padded(count - 1 - index)}`,
          }),
        ),
      });

      const indexed = await harness.open(
        conformanceBundle,
        threadsWith([
          ...threadIndexes,
          { name: 'byCreated', fields: ['createdAt'] },
        ]),
      );
      const pages = await walk(indexed, {
        type: thread,
        index: 'byCreated',
        equals: [],
        limit: 100,
      });

      assert.deepEqual(
        pages.flatMap(ids),
        range(count)
          .reverse()
          .map((index) => `t${padded(index)}`),
      );
      assert.deepEqual(await revisions(indexed, [threadKey('t00000')]), [1]);
    },
    { timeout: 300_000 },
  ),
];

/**
 * The cases, in run order, group `registration`: REG1–REG5, then the
 * generation cases GEN1–GEN3, each on a fresh engine. None is skipped.
 */
export const registrationCases: readonly V2Case[] = Object.freeze([
  ...cases,
  ...generationCases,
]);
