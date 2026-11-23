import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestServices } from 'bundle/testing';

import { kernelPorts } from '../src/host/ports.js';
import { fakeThreadState, promptId } from './support/harness.js';

/*
 * The kernel ports read today's kernel contracts; these tests cover what they
 * add over them: the image reader a run gets from its session. Everything else
 * the ports answer is covered through the runs of the kernel entry.
 */

const catId = `sha256-${'a'.repeat(64)}`;
const cat = {
  id: catId,
  name: 'cat.png',
  mediaType: 'image/png' as const,
  size: 8,
  bytes: 'iVBORw0KGgo=',
};

const ports = () =>
  kernelPorts(createTestServices({ bundle: { id: 'default' } }).services);

void test('C5 images(session) reads an attachment of the session as its name and a data: URL', async () => {
  const state = fakeThreadState();
  state.attach(cat);

  const read = ports().images(state.session(promptId));

  assert.ok(read !== undefined);
  assert.deepEqual(await read(catId), {
    name: 'cat.png',
    imageUrl: 'data:image/png;base64,iVBORw0KGgo=',
  });
});

void test('C5 images(session) answers undefined for an id the Project holds no attachment by', async () => {
  const read = ports().images(fakeThreadState().session(promptId));

  assert.ok(read !== undefined);
  assert.equal(await read(`sha256-${'b'.repeat(64)}`), undefined);
});

void test('C5 images(session) is undefined for a session without attachment', () => {
  const { attachment: _, ...session } = fakeThreadState().session(promptId);

  assert.equal(ports().images(session), undefined);
});
