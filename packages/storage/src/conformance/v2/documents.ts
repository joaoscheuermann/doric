/**
 * Documents and revision conflicts over `storage/v2` (T4.3): D1–D6 and
 * R1–R3 on binary values, and D7 rewritten (PF7) for registration, which
 * replaces `declareType`. Every case runs on the shared engine.
 */
import assert from 'node:assert/strict';

import { create, toBinary } from '@bufbuild/protobuf';

import { NoteSchema } from '../../contracts/gen/doric/storage/conformance/v1/conformance_pb.js';
import { otherFiles, otherItem, textOf, without } from './files.js';
import {
  documentBytes,
  noteKey,
  notePut,
  plainKey,
  plainPut,
  revisions,
  sizedNote,
  stored,
  threadKey,
  view,
  views,
} from './fixtures.js';
import {
  caseGroup,
  conformanceBundle,
  conformanceFiles,
  type V2Case,
} from './harness.js';
import { revisionCases } from './revisions.js';
import { isCode, storedKeys } from './support.js';

const documents = caseGroup('documents');
const timeout = 300_000;
const decoder = new TextDecoder();

/** The keys of `after` that `before` lacks, as text. */
const added = (
  before: readonly Uint8Array[],
  after: readonly Uint8Array[],
): string[] => {
  const known = new Set(before.map((key) => Buffer.from(key).toString('hex')));

  return after
    .filter((key) => !known.has(Buffer.from(key).toString('hex')))
    .map((key) => decoder.decode(key));
};

const cases: readonly V2Case[] = [
  documents(
    'D1',
    'a put document reads back as stored, whatever its fields hold',
    async (harness) => {
      const storage = await harness.open();
      const written: [string, Parameters<typeof notePut>[1]][] = [
        ['empty', {}],
        ['text', { title: 'a title with é and 日本', tag: 'shared' }],
        ['bytes', { title: 'bytes', body: Uint8Array.of(0, 1, 127, 128, 255) }],
        [
          'long',
          {
            title: 't'.repeat(64),
            tag: 'x',
            body: new Uint8Array(4096).fill(120),
          },
        ],
      ];

      await storage.commit({
        put: written.map(([id, init]) => notePut(id, init)),
      });

      const expected = written.map(([id, init]) =>
        view({
          type: noteKey(id).type,
          id,
          revision: 1,
          value: create(NoteSchema, init),
        }),
      );
      const keys = written.map(([id]) => noteKey(id));

      assert.deepEqual(await views(storage, keys), expected);
      // Another instance over the same store reads the same documents.
      assert.deepEqual(await views(await harness.open(), keys), expected);
    },
  ),
  documents(
    'D2',
    'the first revision is 1 and each put adds one, two puts in one batch included',
    async (harness) => {
      const storage = await harness.open();

      await storage.commit({ put: [notePut('n1', { title: 'v1' })] });
      assert.deepEqual(await revisions(storage, [noteKey('n1')]), [1]);

      await storage.commit({ put: [notePut('n1', { title: 'v2' })] });
      await storage.commit({ put: [notePut('n1', { title: 'v3' })] });
      assert.deepEqual(
        view(await storage.get(noteKey('n1'))),
        stored(noteKey('n1'), 3, { title: 'v3' }),
      );

      // Two puts of one document in one batch are two revisions; the last value wins.
      await storage.commit({
        put: [
          notePut('n1', { title: 'first' }),
          notePut('n1', { title: 'last' }),
        ],
      });
      assert.deepEqual(
        view(await storage.get(noteKey('n1'))),
        stored(noteKey('n1'), 5, { title: 'last' }),
      );
    },
  ),
  documents(
    'D3',
    'a deleted document is gone, and created again it starts over at revision 1',
    async (harness) => {
      const storage = await harness.open();

      await storage.commit({
        put: [notePut('n1', { title: 'a' }), notePut('n2', { title: 'b' })],
      });
      await storage.commit({ put: [notePut('n1', { title: 'a2' })] });
      await storage.commit({ delete: [noteKey('n1')] });
      assert.equal(await storage.get(noteKey('n1')), undefined);
      assert.deepEqual(await views(storage, [noteKey('n2')]), [
        stored(noteKey('n2'), 1, { title: 'b' }),
      ]);

      // Deleting an absent document is not an error.
      await storage.commit({ delete: [noteKey('n1'), noteKey('never')] });

      await storage.commit({ put: [notePut('n1', { title: 'again' })] });
      assert.deepEqual(
        view(await storage.get(noteKey('n1'))),
        stored(noteKey('n1'), 1, { title: 'again' }),
      );

      // A delete and a put of one document in one batch recreate it.
      await storage.commit({
        delete: [noteKey('n2')],
        put: [notePut('n2', { title: 'fresh' })],
      });
      assert.deepEqual(
        view(await storage.get(noteKey('n2'))),
        stored(noteKey('n2'), 1, { title: 'fresh' }),
      );
    },
  ),
  documents(
    'D4',
    'a document never written is undefined, in any type',
    async (harness) => {
      const storage = await harness.open();

      assert.equal(await storage.get(noteKey('missing')), undefined);
      await storage.commit({ put: [notePut('n1', { title: 'x' })] });
      assert.equal(await storage.get(noteKey('missing')), undefined);
      // The same id in another type is another document.
      assert.equal(await storage.get(threadKey('n1')), undefined);
      assert.equal(await storage.get(plainKey('n1')), undefined);
    },
  ),
  documents(
    'D5',
    'an expect mismatch is revision_conflict and nothing of the batch applies',
    async (harness) => {
      const storage = await harness.open();

      await storage.commit({ put: [notePut('n1', { title: 'v1' })] });
      await assert.rejects(
        storage.commit({
          expect: [{ ...noteKey('n1'), revision: 2 }],
          put: [notePut('n1', { title: 'v2' }), notePut('n2', { title: 'n2' })],
          delete: [noteKey('n1')],
        }),
        isCode('revision_conflict'),
      );
      assert.deepEqual(await views(storage, [noteKey('n1'), noteKey('n2')]), [
        stored(noteKey('n1'), 1, { title: 'v1' }),
        undefined,
      ]);
    },
  ),
  documents(
    'D6',
    'expect revision 0 passes only while the document is absent',
    async (harness) => {
      const storage = await harness.open();
      const create = (title: string) => ({
        expect: [{ ...noteKey('n1'), revision: 0 }],
        put: [notePut('n1', { title })],
      });

      await storage.commit(create('created'));
      assert.deepEqual(await revisions(storage, [noteKey('n1')]), [1]);
      await assert.rejects(
        storage.commit(create('twice')),
        isCode('revision_conflict', {
          ...noteKey('n1'),
          expected: 0,
          actual: 1,
        }),
      );
      assert.deepEqual(await views(storage, [noteKey('n1')]), [
        stored(noteKey('n1'), 1, { title: 'created' }),
      ]);

      // After a delete the document is absent again.
      await storage.commit({ delete: [noteKey('n1')] });
      await storage.commit(create('recreated'));
      assert.deepEqual(
        view(await storage.get(noteKey('n1'))),
        stored(noteKey('n1'), 1, { title: 'recreated' }),
      );

      // Expecting an absent document at another revision fails with actual 0.
      await assert.rejects(
        storage.commit({ expect: [{ ...noteKey('n2'), revision: 1 }] }),
        isCode('revision_conflict', {
          ...noteKey('n2'),
          expected: 1,
          actual: 0,
        }),
      );
    },
  ),
  documents(
    'D7',
    'a registration that leaves Plain out keeps its documents and its declaration',
    async (harness) => {
      const storage = await harness.open();

      await storage.commit({ put: [plainPut('p1', 'kept')] });

      const [conformance] = conformanceFiles;

      assert.ok(conformance, 'the conformance file');

      const narrower = await harness.open(conformanceBundle, [
        without(conformance, 'Plain'),
      ]);

      // The documents stay, and so does the declaration: a put still passes.
      assert.deepEqual(await views(storage, [plainKey('p1')]), [
        stored(plainKey('p1'), 1, { text: 'kept' }),
      ]);
      await storage.commit({ put: [plainPut('p2', 'after')] });
      assert.deepEqual(await revisions(storage, [plainKey('p2')]), [1]);
      // The narrower instance has no message for Plain: refused before any call.
      await assert.rejects(
        narrower.get(plainKey('p1')),
        isCode('invalid_input'),
      );
    },
  ),
  documents(
    'T4.3-prefix',
    'every key a bundle writes starts with its prefix',
    async (harness) => {
      const empty = await storedKeys(harness.engine.kv('doric'));
      const storage = await harness.open();

      await storage.commit({
        put: [notePut('n1', { title: 'one', tag: 't' }), plainPut('p1', 'p')],
      });

      const mine = await storedKeys(harness.engine.kv('doric'));
      const written = added(empty, mine);

      assert.ok(written.length > 0, 'conformance wrote keys');
      for (const key of written) {
        assert.ok(key.startsWith(`${conformanceBundle}/`), key);
      }

      const { file, item } = otherFiles();
      const other = await harness.open('other', [file]);

      await other.commit({
        put: [{ type: otherItem, id: 'n1', value: textOf(item, 'o') }],
      });

      const theirs = added(mine, await storedKeys(harness.engine.kv('doric')));

      assert.ok(theirs.length > 0, 'other wrote keys');
      for (const key of theirs) {
        assert.ok(key.startsWith('other/'), key);
      }
    },
  ),
  documents(
    'T4.3-16MiB',
    'a value of exactly 16 MiB round-trips in chunks',
    async (harness) => {
      const storage = await harness.open();
      const value = sizedNote('big', documentBytes);

      await storage.commit({ put: [{ ...noteKey('big'), value }] });

      const read = await storage.get(noteKey('big'));

      assert.ok(read, 'the document is stored');
      assert.equal(read.revision, 1);
      assert.ok(
        Buffer.from(toBinary(NoteSchema, read.value as typeof value)).equals(
          Buffer.from(toBinary(NoteSchema, value)),
        ),
        'the value reads back byte for byte',
      );
    },
    { timeout },
  ),
];

/**
 * The cases, in run order, groups `documents` and `revision conflicts`:
 * D1–D7, T4.3's prefix and 16 MiB cases, then R1–R3. None is skipped.
 */
export const documentCases: readonly V2Case[] = Object.freeze([
  ...cases,
  ...revisionCases,
]);
