import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

test('the default logger survives a broken stderr pipe', () => {
  const modulePath = resolve(
    'app/desktop/doric/dist-tests/src/platform/log.js',
  );
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const { Writable } = require('node:stream');
    Object.defineProperty(process, 'stderr', {
      value: new Writable({
        write(_chunk, _encoding, callback) {
          callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        }
      })
    });
    const { createPlatformLog } = require(${JSON.stringify(modulePath)});
    createPlatformLog().error({}, 'connection ended');
    setImmediate(() => {});
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});
