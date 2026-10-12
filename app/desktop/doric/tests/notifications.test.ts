import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  type NativeNotification,
  type NotificationApi,
  showNotification,
} from '../src/platform/native/notifications';

interface Shown {
  readonly title: string;
  readonly body: string;
  fail(error: unknown): void;
}

const fakeOs = (supported = true) => {
  const shown: Shown[] = [];
  const api: NotificationApi = {
    isSupported: () => supported,
    create: (options): NativeNotification => {
      let failed: ((event: unknown, error: unknown) => void) | undefined;

      return {
        on: (_event, listener) => {
          failed = listener;
        },
        show: () => {
          shown.push({ ...options, fail: (error) => failed?.({}, error) });
        },
      };
    },
  };

  return { api, shown };
};

describe('native notifications (P15)', () => {
  test('trims each line and bounds it to 200 code points', () => {
    const { api, shown } = fakeOs();
    const long = '😀'.repeat(250);

    showNotification({ title: `  ${long}  `, body: '\n Done \t' }, { api });

    assert.equal(shown.length, 1);
    assert.equal(Array.from(shown[0]?.title ?? '').length, 200);
    assert.equal(shown[0]?.body, 'Done');
  });

  test('an empty or missing title shows nothing', () => {
    const { api, shown } = fakeOs();

    showNotification({ title: '   ', body: 'x' }, { api });
    showNotification({ body: 'x' }, { api });
    showNotification({ title: 7, body: 'x' }, { api });

    assert.equal(shown.length, 0);
  });

  test('an unsupported platform shows nothing and raises nothing', () => {
    const { api, shown } = fakeOs(false);

    showNotification({ title: 'Prompt finished', body: 'x' }, { api });

    assert.equal(shown.length, 0);
  });

  test('a refused notification writes today’s console line', () => {
    const { api, shown } = fakeOs();
    const lines: string[] = [];

    showNotification(
      { title: 'Prompt finished', body: 'x' },
      { api, error: (line) => lines.push(line) },
    );
    shown[0]?.fail(new Error('not signed'));

    assert.deepEqual(lines, ['Doric: notification failed: Error: not signed']);
  });
});
