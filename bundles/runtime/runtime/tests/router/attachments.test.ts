// `runtime.attachments/v1` over the router (phase 3, slice S46a, contract
// §1.8): `Attach` takes the image client streaming (a head, then chunks),
// `Read` answers it server streaming (a head, then chunks of at most 1 MiB),
// in the shape `llms/rpc`'s `AttachmentReadItem` consumes. Tests 22–25 of the
// slice.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { describe } from 'node:test';

import type { MessageInitShape } from '@bufbuild/protobuf';

import type { AttachRequestSchema } from '../../src/contracts/gen/doric/runtime/attachments/v1/attachments_pb.js';
import { testExecution } from '../support/execution.js';
import {
  assertFails,
  type Harness,
  harness,
  seedThread,
  within,
} from './support.js';

type AttachItem = MessageInitShape<typeof AttachRequestSchema>;

const MiB = 1024 * 1024;

/** `size` bytes that start as a PNG, each byte after the signature `fill`. */
const png = (size: number, fill = 7): Uint8Array => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  return bytes;
};

/** The attachment id of `bytes`: `sha256-` and the hex of their hash. */
const idOf = (bytes: Uint8Array) =>
  `sha256-${createHash('sha256').update(bytes).digest('hex')}`;

const head = (name: string): AttachItem => ({
  item: { case: 'head', value: { name } },
});

const chunk = (bytes: Uint8Array): AttachItem => ({
  item: { case: 'chunk', value: bytes },
});

/** `bytes` as chunks of at most 1 MiB. */
const chunks = (bytes: Uint8Array): AttachItem[] => {
  const items: AttachItem[] = [];
  for (let start = 0; start < bytes.length; start += MiB)
    items.push(chunk(bytes.subarray(start, start + MiB)));

  return items;
};

async function* streamOf(items: readonly AttachItem[]) {
  for (const item of items) yield item;
}

/** A started harness with a Project of two Threads, written beforehand. */
const withThreads = async (t: { after(fn: () => unknown): void }) => {
  const h = harness();
  t.after(() => h.stop());
  const { project, thread } = await seedThread(h);
  const { thread: other } = await h.seed.threads.create(
    project.id,
    'Other',
    testExecution,
  );
  await h.start();

  return { h, project, thread, other };
};

/** The items of `Read{id}` under `scope`. */
const read = async (
  h: Harness,
  scope: Parameters<Harness['attachments']>[0],
  id: string,
) => {
  const items = [];
  for await (const item of h.attachments(scope).read({ id })) items.push(item);

  return items;
};

describe('runtime.attachments/v1', () => {
  test('22: Attach with a head and two chunks answers the sha256 attachment with the total size; the same bytes again answer the same id', async (t) => {
    const { h, project, thread } = await withThreads(t);
    const bytes = png(MiB + 1);
    const scope = { projectId: project.id, threadId: thread.id };
    const items = [
      head('screen.png'),
      chunk(bytes.subarray(0, MiB)),
      chunk(bytes.subarray(MiB)),
    ];

    const { attachment } = await within(
      h.attachments(scope).attach(streamOf(items)),
      'Attach',
    );

    assert.ok(attachment !== undefined);
    assert.equal(attachment.id, idOf(bytes));
    assert.equal(attachment.size, MiB + 1);
    assert.equal(attachment.mediaType, 'image/png');
    assert.equal(attachment.name, 'screen.png');

    const again = await within(
      h.attachments(scope).attach(streamOf(items)),
      'Attach again',
    );
    assert.equal(again.attachment?.id, attachment.id);
  });

  test('23: Attach without a threadId scope fails invalid_input', async (t) => {
    const { h, project } = await withThreads(t);

    await assertFails(
      h
        .attachments({ projectId: project.id })
        .attach(streamOf([head('a.png'), ...chunks(png(64))])),
      'invalid_input',
    );
  });

  test('23: a chunk first, a second head, or 5 MiB + 1 byte fail invalid_input and store nothing', async (t) => {
    const { h, project, thread } = await withThreads(t);
    const scope = { projectId: project.id, threadId: thread.id };
    const first = png(64, 1);
    const twice = png(64, 2);
    const oversized = png(5 * MiB + 1, 3);
    const cases: readonly { what: string; items: AttachItem[]; bytes: Uint8Array }[] = [
      { what: 'a chunk first', items: chunks(first), bytes: first },
      {
        what: 'a second head',
        items: [head('a.png'), ...chunks(twice), head('b.png')],
        bytes: twice,
      },
      {
        what: '5 MiB + 1 byte',
        items: [head('big.png'), ...chunks(oversized)],
        bytes: oversized,
      },
    ];

    for (const { what, items, bytes } of cases) {
      await assertFails(
        h.attachments(scope).attach(streamOf(items)),
        'invalid_input',
      );
      const answer = await read(h, scope, idOf(bytes));
      assert.equal(answer.length, 1, `${what}: one item`);
      assert.equal(answer[0]?.item.case, 'head', what);
      assert.equal(
        answer[0]?.item.case === 'head'
          ? answer[0].item.value.attachment
          : 'not a head',
        undefined,
        `${what}: nothing stored`,
      );
    }
  });

  test("24: Read under another Thread of the Project answers a head, then chunks of at most 1 MiB joining to the attached bytes, in llms/rpc's shape", async (t) => {
    const { h, project, thread, other } = await withThreads(t);
    const bytes = png(2 * MiB + 10, 9);
    const { attachment } = await within(
      h
        .attachments({ projectId: project.id, threadId: thread.id })
        .attach(streamOf([head('big.png'), ...chunks(bytes)])),
      'Attach',
    );
    assert.ok(attachment !== undefined);

    const items = await read(h, { threadId: other.id }, attachment.id);

    const [first, ...rest] = items;
    assert.equal(first?.item.case, 'head');
    assert.deepEqual(
      first.item.case === 'head'
        ? {
            mediaType: first.item.value.attachment?.mediaType,
            name: first.item.value.attachment?.name,
          }
        : undefined,
      { mediaType: 'image/png', name: 'big.png' },
    );
    const parts: Uint8Array[] = [];
    for (const { item } of rest) {
      assert.equal(item.case, 'chunk');
      if (item.case !== 'chunk') continue;
      assert.ok(item.value instanceof Uint8Array);
      assert.ok(item.value.length > 0 && item.value.length <= 1_048_576);
      parts.push(item.value);
    }
    assert.deepEqual(Buffer.concat(parts), Buffer.from(bytes));
  });

  test('25: Read of an unknown id answers one head without attachment and no chunk; without scope it fails invalid_input', async (t) => {
    const { h, thread } = await withThreads(t);

    const items = await read(h, { threadId: thread.id }, idOf(png(16)));
    assert.equal(items.length, 1);
    assert.equal(items[0]?.item.case, 'head');
    assert.equal(
      items[0]?.item.case === 'head' ? items[0].item.value.attachment : 'x',
      undefined,
    );

    await assertFails(read(h, undefined, idOf(png(16))), 'invalid_input');
  });
});
