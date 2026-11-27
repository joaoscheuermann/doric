// `files`' host part through the router (phase 3, slice S53a, tests T1–T8):
// `activate` registers the seven workspace tools with `tools/v1` (always
// available, positions 100–850), and `core`'s
// `ToolHandlerService` calls run them over `runtime.workspace/v1`,
// `runtime.lease/v1` and `runtime.attachments/v1` under the relayed prompt
// scope. Each tool's answers case by case are the tool suites' (`cwd`, `edit`,
// `find`, `grep`, `tree`, `view-image`, `write`), which run through the router
// too (`routedTool`).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { JsonValue } from '@bufbuild/protobuf';
import { ContractError } from 'bundle/contracts';
import { attachmentReference } from 'runtime/contracts';

import { tool as cwdTool, repositoryNote } from '../src/host/tools/cwd.js';
import { tool as editTool } from '../src/host/tools/edit.js';
import { tool as findTool } from '../src/host/tools/find.js';
import { tool as grepTool } from '../src/host/tools/grep.js';
import { tool as treeTool } from '../src/host/tools/tree.js';
import { tool as viewImageTool } from '../src/host/tools/view-image.js';
import { tool as writeTool } from '../src/host/tools/write.js';
import { type FakeHostOptions, fakeHost } from './fake-sandbox.js';
import { diskSandbox, harness, MIB, promptScope } from './support/router.js';
import {
  activated,
  callsOf,
  execute,
  rejectionOf,
  targetOf,
  workspace,
} from './support/router-fixtures.js';

/** The bytes that open every PNG, then a little body. */
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);

/** The part over a disk sandbox of `root` and a fake Thread of `hostOptions`. */
const partOver = (
  t: TestContext,
  root: string,
  hostOptions: FakeHostOptions = {},
) =>
  activated(t, {
    sandbox: diskSandbox(root),
    host: fakeHost({ localRoot: root, ...hostOptions }),
  });

// T1.
void test('T1: activate sends seven tools/v1.Register in catalog order, always available, with the definitions’ schemas', async (t) => {
  const h = await partOver(t, await workspace(t));
  const expected = [
    [cwdTool, 100],
    [editTool, 200],
    [findTool, 300],
    [grepTool, 400],
    [treeTool, 600],
    [writeTool, 800],
    [viewImageTool, 850],
  ] as const;

  assert.deepEqual(
    h.registers,
    expected.map(([tool, order]) =>
      JSON.parse(
        JSON.stringify({
          tool: {
            name: tool.name,
            description: tool.description,
            definition: {
              name: tool.definition.name,
              description: tool.definition.description,
              inputSchema: JSON.stringify(tool.definition.inputSchema),
              outputSchema: JSON.stringify(tool.definition.outputSchema),
              strict: tool.definition.strict,
            },
            ...(tool === viewImageTool ? { resultModalities: ['image'] } : {}),
          },
          options: { alwaysAvailable: true, order },
        }),
      ),
    ),
  );
});

// T2.
void test('T2: a Register refused duplicate_tool rejects activate with it, and the tools registered before it are served', async (t) => {
  const root = await workspace(t);
  const h = harness({
    sandbox: diskSandbox(root),
    host: fakeHost({ localRoot: root }),
    registerError: {
      name: 'grep',
      error: new ContractError('duplicate_tool', 'grep is taken.'),
    },
  });

  t.after(() => h.router.control.stop());

  const error = await rejectionOf(h.activate());

  assert.equal(error.code, 'duplicate_tool');
  assert.deepEqual(
    h.registers.map((r) => (r as { tool: { name: string } }).tool.name),
    ['cwd', 'edit', 'find', 'grep'],
  );
  assert.deepEqual(await execute(h, 'cwd', {}), {
    cwd: '/workspace',
    status: 'reported',
    repositoryRoot: false,
  });
});

// T3.
void test('T3: cwd reports without a path, sends SetCwd{path: trimmed} then Location{}, and maps every outcome', async (t) => {
  const files = { 'repo/.keep': '', 'src/.keep': '', 'notes.txt': 'notes\n' };
  const hostOptions = { repositoryRoots: ['/workspace/repo'] };
  const cases: readonly (readonly [JsonValue, JsonValue])[] = [
    [{}, { cwd: '/workspace', status: 'reported', repositoryRoot: false }],
    [
      { path: ' src ' },
      { cwd: '/workspace/src', status: 'set', repositoryRoot: false },
    ],
    [
      { path: '/etc' },
      {
        cwd: '/workspace',
        status: 'refused',
        reason: 'outside',
        repositoryRoot: false,
      },
    ],
    [
      { path: 'nope' },
      {
        cwd: '/workspace',
        status: 'refused',
        reason: 'missing',
        repositoryRoot: false,
      },
    ],
    [
      { path: 'notes.txt' },
      {
        cwd: '/workspace',
        status: 'refused',
        reason: 'not-directory',
        repositoryRoot: false,
      },
    ],
    [
      { path: 'repo' },
      {
        cwd: '/workspace/repo',
        status: 'set',
        repositoryRoot: true,
        note: repositoryNote,
      },
    ],
  ];

  for (const [payload, answer] of cases) {
    const root = await workspace(t, files);
    const h = await partOver(t, root, hostOptions);

    assert.deepEqual(await execute(h, 'cwd', payload), answer);

    const asked = (payload as { path?: string }).path;

    assert.deepEqual(
      callsOf(h, 'workspace').map((call) => [call.method, call.request]),
      asked === undefined
        ? [['location', {}]]
        : [
            ['setCwd', { path: asked.trim() }],
            ['location', {}],
          ],
    );
  }
});

/** One T4 case: the seed, the tool, its payload and what it must answer. */
interface LeaseCase {
  readonly label: string;
  readonly files: Readonly<Record<string, string>>;
  readonly tool: { readonly name: string };
  readonly payload: JsonValue;
  /** Checks the parsed answer. */
  readonly answers: (answer: JsonValue | undefined) => void;
  /** Files (path → content) the workspace must hold after the call. */
  readonly holds?: Readonly<Record<string, string>>;
}

/** The field `key` of an answer object. */
const field = (
  answer: JsonValue | undefined,
  key: string,
): JsonValue | undefined =>
  (answer as Record<string, JsonValue> | undefined)?.[key];

const leaseCases: readonly LeaseCase[] = [
  {
    label: 'edit',
    files: { 'src/lib.ts': 'one\noldCall();\nthree\n' },
    tool: editTool,
    payload: {
      path: 'src/lib.ts',
      edits: [{ oldText: 'oldCall();', newText: 'newCall();' }],
    },
    answers: (answer) => {
      assert.equal(field(answer, 'success'), true);
      assert.equal(field(answer, 'first_changed_line'), 2);
    },
    holds: { 'src/lib.ts': 'one\nnewCall();\nthree\n' },
  },
  {
    label: 'edit refusal (duplicate old text)',
    files: { 'same.txt': 'same\nsame\n' },
    tool: editTool,
    payload: { path: 'same.txt', edits: [{ oldText: 'same', newText: 'x' }] },
    answers: (answer) => {
      assert.equal(field(answer, 'success'), false);
      assert.match(
        String(field(answer, 'error')),
        /Please provide more context/,
      );
    },
    holds: { 'same.txt': 'same\nsame\n' },
  },
  {
    label: 'write',
    files: { 'notes/today.txt': 'old\n' },
    tool: writeTool,
    payload: { path: 'notes/today.txt', content: 'hello\n' },
    answers: (answer) => {
      assert.equal(field(answer, 'success'), true);
      assert.equal(field(answer, 'bytes_written'), 6);
    },
    holds: { 'notes/today.txt': 'hello\n' },
  },
  {
    label: 'find',
    files: { 'src/a.ts': 'a', 'src/nested/b.ts': 'b', 'src/c.txt': 'c' },
    tool: findTool,
    payload: { pattern: '*.ts', path: 'src' },
    answers: (answer) =>
      assert.deepEqual(answer, {
        results: ['a.ts', 'nested/b.ts'],
        total: 2,
        truncated: false,
      }),
  },
  {
    label: 'grep',
    files: {
      'src/one.ts': 'before one\nconst value = Target;\nafter one\n',
      'src/two.txt': 'Target\n',
    },
    tool: grepTool,
    payload: { pattern: 'Target', path: 'src', glob: '*.ts', context: 1 },
    answers: (answer) => {
      assert.equal(field(answer, 'total'), 1);
      assert.deepEqual((field(answer, 'matches') as JsonValue[])[0], {
        file: 'one.ts',
        line: 2,
        text: 'const value = Target;',
        context_before: ['before one'],
        context_after: ['after one'],
      });
    },
  },
  {
    label: 'tree',
    files: { 'src/lib.ts': 'lib', 'visible.txt': 'visible' },
    tool: treeTool,
    payload: { path: '.' },
    answers: (answer) => {
      assert.equal(typeof answer, 'string');
      assert.match(String(answer), /lib\.ts/);
      assert.match(String(answer), /visible\.txt/);
    },
  },
];

// T4.
void test('T4: edit, write, find, grep and tree answer over one Describe{target: {}} and expectSandboxId on every later lease call', async (t) => {
  for (const {
    label,
    files,
    tool,
    payload,
    answers,
    holds = {},
  } of leaseCases) {
    const root = await workspace(t, files);
    const h = await partOver(t, root);

    answers(await execute(h, tool.name, payload));

    for (const [file, content] of Object.entries(holds)) {
      assert.equal(
        await readFile(path.join(root, file), 'utf8'),
        content,
        `${label}: ${file}`,
      );
    }

    const [describe, ...more] = callsOf(h, 'lease', 'describe');
    const later = callsOf(h, 'lease').filter((c) => c.method !== 'describe');

    assert.ok(describe !== undefined, `${label}: no Describe`);
    assert.equal(more.length, 0, `${label}: one Describe`);
    assert.deepEqual(targetOf(describe), {}, label);
    assert.ok(later.length > 0, `${label}: a lease call after Describe`);

    for (const call of later) {
      assert.deepEqual(
        targetOf(call),
        { expectSandboxId: 'fake-sandbox' },
        `${label}: ${call.method}`,
      );
    }

    for (const call of callsOf(h, 'lease')) {
      assert.deepEqual(call.scope, promptScope, `${label}: ${call.method}`);
    }
  }
});

// T5.
void test('T5: a sandbox switched after Describe fails Execute unavailable with leaseStatus, and write writes nothing', async (t) => {
  const root = await workspace(t, { 'src/lib.ts': 'lib' });
  const h = await partOver(t, root);

  h.lease.switchAfterDescribe = 'other-sandbox';

  const error = await rejectionOf(execute(h, 'tree', { path: '.' }));

  assert.equal(error.code, 'unavailable');
  assert.deepEqual(error.details, { leaseStatus: 'unavailable' });

  h.lease.sandboxId = 'fake-sandbox';
  h.lease.switchAfterDescribe = 'third-sandbox';

  const written = await execute(h, 'write', {
    path: 'fresh.txt',
    content: 'never',
  });

  assert.equal((written as { success?: boolean }).success, false);
  await assert.rejects(stat(path.join(root, 'fresh.txt')), { code: 'ENOENT' });
});

// T6.
void test('T6: view-image reads ReadFileBytes{target: {}, path: absolute}, attaches head{name} then the bytes in order, and answers the attachment’s line', async (t) => {
  const image = Buffer.concat([png, Buffer.alloc(2 * MIB + MIB / 2, 7)]);
  const root = await workspace(t, { 'shots/cat.png': image });
  const h = await partOver(t, root, { cwd: '/workspace/shots' });

  const answer = await execute(h, 'view-image', { path: 'cat.png' });
  const [read] = callsOf(h, 'lease', 'readFileBytes');

  assert.ok(read !== undefined, 'no ReadFileBytes');
  assert.deepEqual(targetOf(read), {});
  assert.deepEqual((read.request as { request: unknown }).request, {
    path: '/workspace/shots/cat.png',
  });
  assert.deepEqual(
    callsOf(h, 'attachments').map((call) => call.request),
    [{ name: 'cat.png' }],
  );
  assert.equal(h.attached.length, 1);
  assert.ok(h.attached[0]?.bytes.equals(image), 'the bytes differ');

  const id = `sha256-${createHash('sha256').update(image).digest('hex')}`;

  assert.equal(answer, attachmentReference('cat.png', id));
});

// T7.
void test('T7: view-image of a text file fails invalid_input; an over-size file fails invalid_input and the read stream is cancelled', async (t) => {
  const chunks = 16;
  const root = await workspace(t, {
    'notes.png': 'plain text',
    'huge.png': Buffer.concat([png, Buffer.alloc(chunks * MIB - png.length)]),
  });
  const h = await partOver(t, root);

  const text = await rejectionOf(
    execute(h, 'view-image', { path: 'notes.png' }),
  );

  assert.equal(text.code, 'invalid_input');

  h.lease.chunksPulled = 0;

  const huge = await rejectionOf(
    execute(h, 'view-image', { path: 'huge.png' }),
  );

  assert.equal(huge.code, 'invalid_input');
  assert.ok(
    h.lease.chunksPulled < chunks,
    `${h.lease.chunksPulled} of ${chunks} chunks were pulled`,
  );
  assert.equal(h.attached.length, 0);
});

// T8.
void test('T8: every port call carries the Execute call’s scope, and thread_control_inactive passes through with its code', async (t) => {
  const root = await workspace(t, { 'src/a.ts': 'a', 'shots/cat.png': png });
  const h = await partOver(t, root);

  await execute(h, 'cwd', { path: 'src' });
  await execute(h, 'cwd', { path: '..' });
  await execute(h, 'find', { pattern: '*.ts' });
  await execute(h, 'view-image', { path: 'shots/cat.png' });

  assert.deepEqual([...new Set(h.calls.map((call) => call.service))].sort(), [
    'attachments',
    'lease',
    'workspace',
  ]);

  for (const call of h.calls) {
    assert.deepEqual(call.scope, promptScope, `${call.service}.${call.method}`);
  }

  h.lease.error = new ContractError(
    'thread_control_inactive',
    'The prompt has ended.',
  );

  const error = await rejectionOf(execute(h, 'find', { pattern: '*.ts' }));

  assert.equal(error.code, 'thread_control_inactive');
});
