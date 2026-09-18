import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { walk } from '../src/lib/walk.js';

const tempRoot = async (context: TestContext): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'okf-walk-'));

  context.after(() => fs.rm(root, { recursive: true, force: true }));

  return root;
};

const write = async (
  root: string,
  relative: string,
  body = relative,
): Promise<void> => {
  const target = path.join(root, ...relative.split('/'));

  await fs.mkdir(path.dirname(target), { recursive: true });

  await fs.writeFile(target, body, 'utf-8');
};

const relative = (root: string, file: string): string =>
  path.relative(root, file).split(path.sep).join('/');

const deferred = (): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} => {
  let resolve = (): void => undefined;

  const promise = new Promise<void>((done) => {
    resolve = done;
  });

  return { promise, resolve };
};

test('finds all nested files before processing them', async (context) => {
  const root = await tempRoot(context);

  await Promise.all([
    write(root, 'root.txt'),
    write(root, 'docs/guide.md'),
    write(root, 'docs/nested/detail.txt'),
  ]);

  const seen: string[] = [];

  const files = await walk(
    root,
    async (file) => {
      seen.push(relative(root, file));
    },
    { batchSize: 2 },
  );

  assert.deepEqual(
    files.map((file) => relative(root, file)),
    ['docs/guide.md', 'docs/nested/detail.txt', 'root.txt'],
  );

  assert.deepEqual([...seen].sort(), [
    'docs/guide.md',
    'docs/nested/detail.txt',
    'root.txt',
  ]);
});

test('runs one concurrent batch at a time up to batchSize', async (context) => {
  const root = await tempRoot(context);

  await Promise.all(
    Array.from({ length: 5 }, (_, index) => write(root, `${index}.txt`)),
  );

  const started: string[] = [];
  const releases: Array<() => void> = [];
  const reached = [deferred(), deferred(), deferred()];
  let active = 0;
  let maximum = 0;

  const walking = walk(
    root,
    async (file) => {
      started.push(relative(root, file));

      if (started.length === 2) {
        reached[0]?.resolve();
      }

      if (started.length === 4) {
        reached[1]?.resolve();
      }

      if (started.length === 5) {
        reached[2]?.resolve();
      }

      active += 1;

      maximum = Math.max(maximum, active);

      await new Promise<void>((resolve) => {
        releases.push(() => {
          active -= 1;

          resolve();
        });
      });
    },
    { batchSize: 2 },
  );

  await reached[0]?.promise;

  assert.equal(active, 2);

  assert.deepEqual([...started].sort(), ['0.txt', '1.txt']);

  releases[0]?.();

  assert.equal(active, 1);

  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(started.length, 2);

  releases[1]?.();

  await reached[1]?.promise;

  assert.equal(active, 2);

  assert.deepEqual(started.slice(2).sort(), ['2.txt', '3.txt']);

  releases[2]?.();

  releases[3]?.();

  await reached[2]?.promise;

  assert.equal(active, 1);

  releases[4]?.();

  await walking;

  assert.equal(maximum, 2);

  assert.deepEqual([...started].sort(), [
    '0.txt',
    '1.txt',
    '2.txt',
    '3.txt',
    '4.txt',
  ]);
});

test('does not process files created after discovery', async (context) => {
  const root = await tempRoot(context);

  await Promise.all([write(root, 'a.txt'), write(root, 'b.txt')]);

  const seen: string[] = [];

  const files = await walk(
    root,
    async (file) => {
      seen.push(relative(root, file));

      if (seen.length === 1) {
        await write(root, 'created.txt');
      }
    },
    { batchSize: 1 },
  );

  assert.deepEqual(seen, ['a.txt', 'b.txt']);

  assert.deepEqual(
    files.map((file) => relative(root, file)),
    ['a.txt', 'b.txt'],
  );
});

test('honors scoped gitignore rules and all-depth explicit excludes', async (context) => {
  const root = await tempRoot(context);

  await Promise.all([
    write(root, '.gitignore', 'root-ignored.txt\nignored-dir/\n*.log\n'),
    write(root, 'root-ignored.txt'),
    write(root, 'ignored-dir/file.ts'),
    write(root, 'src/.gitignore', 'ignored.ts\ncache/\n!keep.log\n'),
    write(root, 'src/ignored.ts'),
    write(root, 'src/cache/generated.ts'),
    write(root, 'src/keep.log'),
    write(root, 'src/kept.ts'),
    write(root, 'deep/package-lock.json'),
    write(root, 'deep/manual.pdf'),
    write(root, '.env', 'SECRET=hidden'),
    write(root, '.github/workflows/ci.yml'),
    write(root, '.agents/knowledge/project/index.md'),
    write(root, '.doric/knowledge/index.md'),
    write(root, '.git/config'),
  ]);

  const seen: string[] = [];

  await walk(
    root,
    async (file) => {
      seen.push(relative(root, file));
    },
    { batchSize: 3, ignore: ['package-lock.json', '*.pdf'] },
  );

  assert.deepEqual([...seen].sort(), ['src/keep.log', 'src/kept.ts']);
});

test('does not read symlinked files or symlinked gitignore rules', async (context) => {
  const root = await tempRoot(context);
  const outside = await tempRoot(context);

  await Promise.all([
    write(root, 'visible.txt', 'visible'),
    write(outside, 'secret.txt', 'outside secret'),
    write(outside, '.gitignore', 'visible.txt\n'),
  ]);

  await Promise.all([
    fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'linked.txt')),
    fs.symlink(path.join(outside, '.gitignore'), path.join(root, '.gitignore')),
  ]);

  const seen: string[] = [];

  const files = await walk(root, async (file, body) => {
    seen.push(`${relative(root, file)}:${body}`);
  });

  assert.deepEqual(
    files.map((file) => relative(root, file)),
    ['visible.txt'],
  );

  assert.deepEqual(seen, ['visible.txt:visible']);
});

test('rejects a non-positive or fractional batchSize', async (context) => {
  const root = await tempRoot(context);

  await assert.rejects(
    walk(root, async () => undefined, { batchSize: 0 }),
    /positive integer/u,
  );

  await assert.rejects(
    walk(root, async () => undefined, { batchSize: 1.5 }),
    /positive integer/u,
  );
});
