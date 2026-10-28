import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
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

test('the default logger survives its reader closing full stdout and stderr pipes', async () => {
  const modulePath = resolve(
    'app/desktop/doric/dist-tests/src/platform/log.js',
  );
  // The dev runner (`concurrently`) exiting while main's output is backed up:
  // the writes still pending then fail with EPIPE.
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const { createPlatformLog } = require(${JSON.stringify(modulePath)});
    const log = createPlatformLog();
    const pad = 'x'.repeat(200);
    const writing = setInterval(() => {
      for (let line = 0; line < 200; line += 1) {
        log.info({ line, pad }, 'still running');
        log.error({ line, pad }, 'still running');
      }
    }, 20);
    setTimeout(() => {
      clearInterval(writing);
      process.exit(0);
    }, 1500);
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.pause();
  child.stderr.pause();
  setTimeout(() => {
    child.stdout.destroy();
    child.stderr.destroy();
  }, 500);
  const [code, signal] = await once(child, 'exit');

  assert.deepEqual({ code, signal }, { code: 0, signal: null });
});
