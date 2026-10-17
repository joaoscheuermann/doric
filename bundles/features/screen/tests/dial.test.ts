// The window's dial: the answer of one `screen.sessions/v2.attach`, handed to
// the desktop part with the nonce the request carried, and never thrown.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createScreenDialer } from '../src/client/dial.js';
import type {
  ScreenAttach,
  ScreenAttachReport,
} from '../src/contracts/index.js';

const ready = (projectId: string): ScreenAttach => ({
  status: 'ready',
  path: `/screen/${projectId}/`,
  display: ':100',
});

void test('a dial calls attach and hands the answer over with its sequence', async () => {
  const reports: ScreenAttachReport[] = [];
  const asked: string[] = [];
  const dialer = createScreenDialer({
    attach: async (projectId) => {
      asked.push(projectId);

      return ready(projectId);
    },
    deliver: async (report) => {
      reports.push(report);
    },
  });

  await dialer.dial({ viewId: 'v1', projectId: 'p1', seq: 3 });

  assert.deepEqual(asked, ['p1']);
  assert.deepEqual(reports, [{ viewId: 'v1', seq: 3, answer: ready('p1') }]);
});

void test('a dial that cannot reach the host reports no answer', async () => {
  const reports: ScreenAttachReport[] = [];
  const dialer = createScreenDialer({
    attach: async () => null,
    deliver: async (report) => {
      reports.push(report);
    },
  });

  await dialer.dial({ viewId: 'v1', projectId: 'p1', seq: 1 });

  assert.deepEqual(reports, [{ viewId: 'v1', seq: 1, answer: null }]);
});

void test('a failed report never throws at the loop that asked for the dial', async () => {
  const dialer = createScreenDialer({
    attach: async () => ready('p1'),
    deliver: async () => {
      throw new Error('the desktop part is gone');
    },
  });

  await dialer.dial({ viewId: 'v1', projectId: 'p1', seq: 2 });
});
