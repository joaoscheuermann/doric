// C1 (phase 3, S57; D6): the codec of `papercraft`'s host part. The request
// decoders parse with today's zod schemas (`invalid_input`, "Invalid input
// for papercraft.programs/v1 <Method>."); the answers become the oneof
// messages, which keep their protovalidate rules; `Read`'s items cut each
// file in chunks of at most 1 MiB; the hook inputs keep the four fields the
// library entry reads, an absent `promptId` staying absent.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { create, toJson } from '@bufbuild/protobuf';
import { createValidator } from '@bufbuild/protovalidate';
import { ContractError } from 'bundle/contracts';
import {
  OnPromptStartedHookInputSchema,
  OnThreadCwdChangedHookInputSchema,
} from 'runtime/contracts/gen/doric/runtime/hooks/v1/hooks_pb.js';

import {
  ExportRequestSchema,
  ExportResponseSchema,
  LibraryRequestSchema,
  LibraryResponseSchema,
  ReadRequestSchema,
  ReadResponseSchema,
} from '../src/contracts/gen/doric/papercraft/programs/v1/programs_pb.js';
import type { ExportAnswer, LibraryAnswer } from '../src/contracts/index.js';
import {
  cwdChangedOf,
  exportInputOf,
  exportResponseOf,
  libraryInputOf,
  libraryResponseOf,
  promptStartedOf,
  readInputOf,
  readItemsOf,
} from '../src/host/codec.js';
import { MIB, sha256 } from './support/router.js';

const validator = createValidator();

const MODULE = {
  dir: 'a'.repeat(64),
  files: [
    { path: 'index.js', sha256: 'b'.repeat(64) },
    { path: 'index.css', sha256: 'c'.repeat(64) },
  ],
};

const refusal = (method: string) => (error: unknown) => {
  assert.ok(error instanceof ContractError);
  assert.equal(error.code, 'invalid_input');
  assert.equal(
    error.message,
    `Invalid input for papercraft.programs/v1 ${method}.`,
  );
  return true;
};

describe('C1: request decoders', () => {
  test('Library: a whole turnSequence passes; one above the safe integers is invalid_input', () => {
    assert.deepEqual(
      libraryInputOf(create(LibraryRequestSchema, { turnSequence: 3 })),
      { turnSequence: 3 },
    );
    assert.throws(
      () =>
        libraryInputOf(create(LibraryRequestSchema, { turnSequence: 2 ** 60 })),
      refusal('Library'),
    );
  });

  test('Export: the path, and the name only when given', () => {
    assert.deepEqual(
      exportInputOf(create(ExportRequestSchema, { path: 'src/Card.tsx' })),
      { path: 'src/Card.tsx' },
    );
    assert.deepEqual(
      exportInputOf(
        create(ExportRequestSchema, { path: 'src/Card.tsx', name: 'Primary' }),
      ),
      { path: 'src/Card.tsx', name: 'Primary' },
    );
    assert.throws(
      () => exportInputOf(create(ExportRequestSchema, { path: '' })),
      refusal('Export'),
    );
  });

  test('Read: the dir; an empty one is invalid_input', () => {
    assert.deepEqual(readInputOf(create(ReadRequestSchema, { dir: 'abc' })), {
      dir: 'abc',
    });
    assert.throws(
      () => readInputOf(create(ReadRequestSchema, { dir: '' })),
      refusal('Read'),
    );
  });
});

describe('C1: answers', () => {
  const libraryCases: readonly [LibraryAnswer, unknown][] = [
    [{ status: 'none' }, { none: {} }],
    [
      { status: 'ready', root: '/w/app', module: MODULE },
      { ready: { root: '/w/app', module: MODULE } },
    ],
    [
      { status: 'failed', root: '/w/app', error: 'It broke.' },
      { failed: { root: '/w/app', error: 'It broke.' } },
    ],
    [
      { status: 'failed', error: 'No walk.' },
      { failed: { error: 'No walk.' } },
    ],
  ];

  for (const [answer, json] of libraryCases) {
    test(`Library ${answer.status}${'root' in answer ? ' with a root' : ''} becomes its oneof case and keeps protovalidate`, () => {
      const message = create(LibraryResponseSchema, libraryResponseOf(answer));

      assert.deepEqual(toJson(LibraryResponseSchema, message), json);
      assert.equal(
        validator.validate(LibraryResponseSchema, message).kind,
        'valid',
      );
    });
  }

  const exportCases: readonly [ExportAnswer, unknown][] = [
    [{ status: 'ready', module: MODULE }, { ready: { module: MODULE } }],
    [
      { status: 'failed', error: 'No entry.' },
      { failed: { error: 'No entry.' } },
    ],
  ];

  for (const [answer, json] of exportCases) {
    test(`Export ${answer.status} becomes its oneof case and keeps protovalidate`, () => {
      const message = create(ExportResponseSchema, exportResponseOf(answer));

      assert.deepEqual(toJson(ExportResponseSchema, message), json);
      assert.equal(
        validator.validate(ExportResponseSchema, message).kind,
        'valid',
      );
    });
  }
});

describe('C1: Read items', () => {
  const fileOf = (path: string, length: number) => {
    const bytes = Uint8Array.from({ length }, (_, index) => index % 249);
    return { path: `d/${path}`, sha256: sha256(bytes), bytes };
  };

  test('an empty file, a file of exactly 1 MiB and one of 1 MiB + 1 give one, one and two items, in order', () => {
    const files = [
      fileOf('empty.txt', 0),
      fileOf('one.bin', MIB),
      fileOf('two.bin', MIB + 1),
    ];

    const items = [...readItemsOf(files)].map((init) =>
      create(ReadResponseSchema, init),
    );

    assert.deepEqual(
      items.map(({ path, offset, bytes }) => [path, offset, bytes.length]),
      [
        ['d/empty.txt', 0, 0],
        ['d/one.bin', 0, MIB],
        ['d/two.bin', 0, MIB],
        ['d/two.bin', MIB, 1],
      ],
    );
    for (const item of items) {
      const file = files.find(({ path }) => path === item.path);
      assert.equal(item.sha256, file?.sha256);
      assert.equal(validator.validate(ReadResponseSchema, item).kind, 'valid');
    }
    assert.deepEqual(
      Buffer.concat(
        items
          .filter(({ path }) => path === 'd/two.bin')
          .map(({ bytes }) => bytes),
      ),
      Buffer.from(files[2]?.bytes ?? []),
    );
  });
});

describe('C1: hook inputs', () => {
  test('promptStartedOf keeps projectId, threadId, promptId and cwd', () => {
    assert.deepEqual(
      promptStartedOf(
        create(OnPromptStartedHookInputSchema, {
          projectId: 'project-1',
          threadId: 'thread-1',
          promptId: 'p1',
          source: { kind: { case: 'user', value: {} } },
          cwd: '/w/app',
          cwdRepo: 'git',
        }),
      ),
      {
        projectId: 'project-1',
        threadId: 'thread-1',
        promptId: 'p1',
        cwd: '/w/app',
      },
    );
  });

  test('cwdChangedOf keeps a promptId when given and leaves an absent one absent', () => {
    const base = {
      projectId: 'project-1',
      threadId: 'thread-1',
      cwd: '/w/next',
      previous: { cwd: '/w/app' },
    };

    const without = cwdChangedOf(
      create(OnThreadCwdChangedHookInputSchema, base),
    );
    const withPrompt = cwdChangedOf(
      create(OnThreadCwdChangedHookInputSchema, { ...base, promptId: 'p1' }),
    );

    assert.deepEqual(without, {
      projectId: 'project-1',
      threadId: 'thread-1',
      cwd: '/w/next',
    });
    assert.equal('promptId' in without, false);
    assert.deepEqual(withPrompt, {
      projectId: 'project-1',
      threadId: 'thread-1',
      promptId: 'p1',
      cwd: '/w/next',
    });
  });
});
