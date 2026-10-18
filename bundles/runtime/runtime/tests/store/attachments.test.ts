import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createTestServices } from 'bundle';
import { isContractError } from 'bundle/contracts';

import {
  ATTACHMENT_MAX_BYTES,
  type RuntimeAttachments,
  RuntimeAttachmentsV1,
} from '../../src/contracts/attachments.js';
import { attachmentsService } from '../../src/host/services/attachments.js';
import type { RuntimeStores } from '../../src/host/store/index.js';
import { type Backend, backends, snapshot, stores } from './support.js';

const png = (marker: number) =>
  Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0x00,
    marker,
  ]).toString('base64');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString(
  'base64',
);

/** The blob an attachment id names, as storage/v1 reads it. */
const blobOf = (backend: Backend, id: string) =>
  backend.storage.getBlob(`sha256:${id.slice('sha256-'.length)}`);

interface Context extends RuntimeStores {
  readonly backend: Backend;
  /** runtime.attachments/v1 as a Thread's caller reaches it. */
  readonly from: (threadId: string) => RuntimeAttachments;
  /** A new Project with one Thread; the Thread is idle, so not terminal. */
  readonly project: () => Promise<{ projectId: string; threadId: string }>;
}

const attachmentTest = (
  name: string,
  run: (context: Context) => Promise<void>,
) => {
  for (const { name: backendName, open, skip } of backends)
    void test(`${name} (${backendName})`, { skip }, async () => {
      const backend = await open();
      const runtime = stores(backend.storage);
      const { services, dispose } = createTestServices({
        bundle: { id: 'runtime' },
        provide: [
          attachmentsService({
            attachments: runtime.attachments,
            threads: runtime.threads,
          }),
        ],
      });
      try {
        await run({
          ...runtime,
          backend,
          from: (threadId) => services.use(RuntimeAttachmentsV1, { threadId }),
          project: async () => {
            const { project } = await runtime.projects.create(
              'Project',
              snapshot(),
              'blue',
            );
            const { thread } = await runtime.threads.create(
              project.id,
              'Thread',
            );
            return { projectId: project.id, threadId: thread.id };
          },
        });
      } finally {
        await dispose();
        await backend.close();
      }
    });
};

const refusedAsInvalid = (error: unknown) =>
  isContractError(error) && error.code === 'invalid_input';

attachmentTest(
  'a Thread reads back the image it attached',
  async ({ from, project }) => {
    const { threadId } = await project();

    const attached = await from(threadId).attach({
      name: 'cat.png',
      bytes: png(1),
    });

    assert.match(attached.id, /^sha256-[0-9a-f]{64}$/u);
    assert.equal(attached.mediaType, 'image/png');
    const read = await from(threadId).read({ id: attached.id });
    assert.equal(read?.bytes, png(1));
    assert.equal(read?.name, 'cat.png');
  },
);

attachmentTest(
  'another Thread of the same Project reads the image',
  async ({ from, project, threads }) => {
    const { projectId, threadId } = await project();
    const child = (await threads.create(projectId, 'Child', threadId)).thread;

    const { id } = await from(threadId).attach({
      name: 'cat.png',
      bytes: png(1),
    });

    assert.equal((await from(child.id).read({ id }))?.bytes, png(1));
  },
);

attachmentTest(
  'another Project cannot read an image it never attached',
  async ({ from, project }) => {
    const first = await project();
    const second = await project();

    const { id } = await from(first.threadId).attach({
      name: 'cat.png',
      bytes: png(1),
    });

    assert.equal(await from(second.threadId).read({ id }), undefined);
  },
);

attachmentTest(
  'the bytes decide the media type and the id, not the name',
  async ({ from, project }) => {
    const { threadId } = await project();

    const first = await from(threadId).attach({ name: 'a.png', bytes: jpeg });
    const second = await from(threadId).attach({ name: 'b.png', bytes: jpeg });

    assert.equal(first.mediaType, 'image/jpeg');
    assert.equal(
      first.id,
      `sha256-${createHash('sha256')
        .update(Buffer.from(jpeg, 'base64'))
        .digest('hex')}`,
    );
    assert.equal(second.id, first.id);
  },
);

attachmentTest(
  'bytes that are not an image a model reads are refused',
  async ({ from, project }) => {
    const { threadId } = await project();

    await assert.rejects(
      from(threadId).attach({
        name: 'notes.png',
        bytes: Buffer.from('plain text').toString('base64'),
      }),
      refusedAsInvalid,
    );
    await assert.rejects(
      from(threadId).attach({ name: 'empty.png', bytes: '' }),
      refusedAsInvalid,
    );
  },
);

attachmentTest(
  'an image over the size limit is refused, one at the limit is kept',
  async ({ from, project }) => {
    const { threadId } = await project();
    const sized = (size: number) => {
      const bytes = Buffer.alloc(size);
      Buffer.from(png(1), 'base64').copy(bytes);
      return bytes.toString('base64');
    };

    const kept = await from(threadId).attach({
      name: 'big.png',
      bytes: sized(ATTACHMENT_MAX_BYTES),
    });
    assert.equal(kept.size, ATTACHMENT_MAX_BYTES);
    await assert.rejects(
      from(threadId).attach({
        name: 'huge.png',
        bytes: sized(ATTACHMENT_MAX_BYTES + 1),
      }),
      refusedAsInvalid,
    );
  },
);

attachmentTest(
  'deleting a Thread deletes the images it attached, bytes and all',
  async ({ backend, from, project, threads }) => {
    const { projectId, threadId } = await project();
    const sibling = (await threads.create(projectId, 'Sibling')).thread;
    const { id } = await from(threadId).attach({
      name: 'cat.png',
      bytes: png(1),
    });
    const kept = await from(sibling.id).attach({
      name: 'dog.png',
      bytes: png(2),
    });

    await threads.setState(threadId, 'cancelled');
    assert.equal(await threads.deleteSubtree(threadId), 'deleted');

    assert.equal(await from(sibling.id).read({ id }), undefined);
    assert.equal(await blobOf(backend, id), undefined);
    assert.equal((await from(sibling.id).read({ id: kept.id }))?.bytes, png(2));
  },
);

attachmentTest(
  'deleting a Thread keeps the bytes another Project still attached',
  async ({ backend, from, project, threads }) => {
    const first = await project();
    const second = await project();
    const { id } = await from(first.threadId).attach({
      name: 'cat.png',
      bytes: png(1),
    });
    await from(second.threadId).attach({ name: 'same.png', bytes: png(1) });

    await threads.setState(first.threadId, 'cancelled');
    assert.equal(await threads.deleteSubtree(first.threadId), 'deleted');

    assert.notEqual(await blobOf(backend, id), undefined);
    assert.equal((await from(second.threadId).read({ id }))?.bytes, png(1));
  },
);

attachmentTest(
  'deleting a Project deletes the images of every Thread it held',
  async ({ backend, from, project, projects, threads }) => {
    const { projectId, threadId } = await project();
    const child = (await threads.create(projectId, 'Child', threadId)).thread;
    const first = await from(threadId).attach({ name: 'a.png', bytes: png(1) });
    const second = await from(child.id).attach({
      name: 'b.png',
      bytes: png(2),
    });

    await threads.setState(threadId, 'cancelled');
    await threads.setState(child.id, 'cancelled');
    await projects.setState(projectId, 'cancelled');
    assert.equal(await projects.delete(projectId), 'deleted');

    assert.equal(await blobOf(backend, first.id), undefined);
    assert.equal(await blobOf(backend, second.id), undefined);
  },
);
