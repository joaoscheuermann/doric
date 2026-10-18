// The block the `artifacts` registry's frame hands the preview body: the
// frame's data (`ArtifactFrameData`) under `block.data`. The body reads the
// revision it draws and the scope it reads it in, and refuses what names no
// revision.

import assert from 'node:assert/strict';
import test from 'node:test';

import { previewBlockDataOf } from '../src/client/block.js';

const frameBlock = (data: Record<string, unknown>) => ({
  id: 'artifacts:checkout-7f3a@2',
  type: 'papercraft.preview/v1',
  promptId: 'pr1',
  sequence: 4,
  data,
});

test('the frame data names the revision and its scope', () => {
  const data = previewBlockDataOf(
    frameBlock({
      artifactId: 'checkout-7f3a',
      revision: 2,
      kind: 'preview',
      title: 'Checkout',
      targets: [{ path: 'src/checkout.html', lines: [3, 9] }],
      entries: [{ path: 'index.html', sha256: 'abc' }],
      changeNote: 'mais respiro',
      createdAt: '2024-01-01T00:00:00Z',
      projectId: 'p1',
      threadId: 't1',
    }),
  );

  assert.deepEqual(data, {
    projectId: 'p1',
    threadId: 't1',
    artifactId: 'checkout-7f3a',
    revision: 2,
    kind: 'preview',
    title: 'Checkout',
    targets: [{ path: 'src/checkout.html', lines: [3, 9] }],
    entries: [{ path: 'index.html', sha256: 'abc' }],
  });
});

test('a frame without a scope still names its revision', () => {
  const data = previewBlockDataOf(
    frameBlock({ artifactId: 'checkout-7f3a', revision: 1, kind: 'preview' }),
  );

  assert.equal(data?.artifactId, 'checkout-7f3a');
  assert.equal(data?.projectId, undefined);
});

test('a block that names no revision is not a preview body', () => {
  assert.equal(
    previewBlockDataOf(frameBlock({ artifactId: 'checkout-7f3a' })),
    undefined,
  );
  assert.equal(
    previewBlockDataOf(frameBlock({ artifactId: '', revision: 1 })),
    undefined,
  );
  assert.equal(previewBlockDataOf(undefined), undefined);
});
