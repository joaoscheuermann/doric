import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { attachmentReferences } from 'runtime/contracts';

import { tool as factory } from '../src/host/tools/view-image.js';
import { createFakeSandbox, fakeHost } from './fake-sandbox.js';
import { type AttachedImages, bindTool } from './support/services.js';

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);

void describe('view-image tool', () => {
  void test('attaches the image and answers the line that names it', async (t) => {
    const root = await workspace();
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'shots'), { recursive: true });
    await writeFile(path.join(root, 'shots', 'cat.png'), png);
    const attached: AttachedImages = new Map();

    const line = await bindTool(
      factory,
      createFakeSandbox(root),
      fakeHost({ cwd: '/workspace/shots' }),
      attached,
    ).execute({ path: 'cat.png' });

    const [reference] = attachmentReferences(line);
    assert.equal(reference?.name, 'cat.png');
    assert.equal(
      attached.get(reference?.id ?? '')?.bytes,
      png.toString('base64'),
    );
  });

  void test('a file that is not an image fails the call', async (t) => {
    const root = await workspace();
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'notes.png'), 'plain text');

    await assert.rejects(
      bindTool(factory, createFakeSandbox(root), fakeHost()).execute({
        path: 'notes.png',
      }),
    );
  });

  void test('a missing file fails the call', async (t) => {
    const root = await workspace();
    t.after(() => rm(root, { recursive: true, force: true }));

    await assert.rejects(
      bindTool(factory, createFakeSandbox(root), fakeHost()).execute({
        path: 'missing.png',
      }),
    );
  });
});

const workspace = () => mkdtemp(path.join(os.tmpdir(), 'doric-view-image-'));
