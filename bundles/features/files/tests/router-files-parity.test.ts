// `files/v1` through the router answers as the kernel `filesService` does
// (phase 3, slice S53b, tests P1–P2): on twin workspaces of the same tree,
// each read and create of the table is asked of both, the routed answer read
// as JSON with implicit fields emitted, the kernel answer normalised as the
// messages carry it (a tree file node's absent `children` and a non-listed
// read's absent `entries` are `[]`).

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import {
  type DescMessage,
  type JsonObject,
  type JsonValue,
  toJson,
} from '@bufbuild/protobuf';

import {
  ContentResponseSchema,
  CreateDirectoryResponseSchema,
  CreateFileResponseSchema,
  DirectoriesResponseSchema,
  DirectoryResponseSchema,
  TreeResponseSchema,
} from '../src/contracts/gen/doric/files/v1/files_pb.js';
import { CONTENT_LIMIT_BYTES } from '../src/host/reads.js';
import type { Harness } from './support/router.js';
import {
  commandSandbox,
  filesPart,
  kernelFiles,
  NOT_READY,
  READ_ONLY_NAME,
} from './support/router-files.js';
import { workspace } from './support/router-fixtures.js';

/** The tree both workspaces hold. */
const TREE = {
  'README.md': 'hello',
  'src/a.ts': 'export const a = 1;\n',
  'src/deep/b.ts': 'b',
  'image.bin': Uint8Array.from([0x89, 0x50, 0x00, 0x47]),
  'big.txt': 'x'.repeat(CONTENT_LIMIT_BYTES + 10),
};

type Method =
  | 'directory'
  | 'tree'
  | 'directories'
  | 'content'
  | 'createFile'
  | 'createDirectory';

const SCHEMAS: Record<Method, DescMessage> = {
  directory: DirectoryResponseSchema,
  tree: TreeResponseSchema,
  directories: DirectoriesResponseSchema,
  content: ContentResponseSchema,
  createFile: CreateFileResponseSchema,
  createDirectory: CreateDirectoryResponseSchema,
};

/** The P1 table: each method with each request it is compared on. */
const CASES: readonly (readonly [Method, JsonObject])[] = [
  ['directory', {}],
  ['directory', { path: 'src' }],
  ['directory', { path: 'missing' }],
  ['directory', { path: 'README.md' }],
  ['directory', { path: '../' }],
  ['tree', {}],
  ['tree', { path: 'src' }],
  ['directories', { paths: ['src', 'src/deep', 'nope'], root: 'src' }],
  ['content', { path: 'README.md' }],
  ['content', { path: 'image.bin' }],
  ['content', { path: 'big.txt' }],
  ['content', { path: 'missing.txt' }],
  ['content', { path: 'src' }],
  ['content', { path: '../outside' }],
  ...(['createFile', 'createDirectory'] as const).flatMap(
    (method): (readonly [Method, JsonObject])[] => [
      [method, { directory: 'src', name: `made-by-${method}` }],
      [method, { directory: 'src', name: 'a.ts' }],
      [method, { directory: 'src', name: 'a/b' }],
      [method, { directory: '../', name: 'x' }],
      [method, { directory: 'nope', name: 'x' }],
      [method, { directory: 'src', name: READ_ONLY_NAME }],
    ],
  ),
];

/** Each object's absent list fields as the message carries them. */
const normalised = (method: Method, value: JsonValue): JsonValue => {
  if (Array.isArray(value))
    return value.map((item) => normalised(method, item));
  if (value === null || typeof value !== 'object') return value;

  const object: JsonObject = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalised(method, item)]),
  );
  const isRead =
    (method === 'directory' || method === 'tree' || method === 'directories') &&
    typeof object.status === 'string' &&
    !['ready', 'pending', 'unavailable', 'expired', 'missing'].includes(
      object.status,
    ) &&
    !('directories' in object);

  if (isRead && object.entries === undefined) object.entries = [];
  if (method === 'tree' && 'type' in object && object.children === undefined) {
    object.children = [];
  }

  return object;
};

/** The routed and the kernel answer of one case, as comparable JSON. */
const answers = async (
  h: Harness,
  kernel: ReturnType<typeof kernelFiles>,
  method: Method,
  request: JsonObject,
): Promise<{ readonly routed: JsonValue; readonly kernel: JsonValue }> => {
  const files = h.files() as unknown as Record<
    Method,
    (request: JsonObject) => Promise<never>
  >;
  const kernelMethods = kernel as unknown as Record<
    Method,
    (request: JsonObject) => Promise<unknown>
  >;
  const routed = toJson(SCHEMAS[method], await files[method](request), {
    alwaysEmitImplicit: true,
  });
  const kernelAnswer = JSON.parse(
    JSON.stringify(await kernelMethods[method](request)),
  ) as JsonValue;

  return { routed, kernel: normalised(method, kernelAnswer) };
};

/** The part and the kernel service over twin workspaces of {@link TREE}. */
const twins = async (
  t: TestContext,
  state: (typeof NOT_READY)[number] | 'ready',
) => {
  const h = await filesPart(t, await workspace(t, TREE));
  const kernel = kernelFiles(
    t,
    commandSandbox(await workspace(t, TREE)),
    state,
  );

  h.lease.status = state;

  return { h, kernel };
};

// P1.
void test('P1: with the lease ready, each read and create answers as the kernel filesService does', async (t) => {
  const { h, kernel } = await twins(t, 'ready');

  for (const [method, request] of CASES) {
    const both = await answers(h, kernel, method, request);

    assert.deepEqual(
      both.routed,
      both.kernel,
      `${method} ${JSON.stringify(request)}`,
    );
  }
});

// P2.
void test('P2: under each non-ready lease, each case answers the kernel’s {status}', async (t) => {
  for (const state of NOT_READY) {
    const { h, kernel } = await twins(t, state);

    for (const [method, request] of CASES) {
      const both = await answers(h, kernel, method, request);

      assert.deepEqual(both.kernel, { status: state });
      assert.deepEqual(
        both.routed,
        both.kernel,
        `${method} ${JSON.stringify(request)} under ${state}`,
      );
    }
  }
});
