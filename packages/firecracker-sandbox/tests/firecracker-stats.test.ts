import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cpuPercent,
  memoryUsedBytes,
  parseGuestStats,
  parseMeminfo,
  parseProcStat,
} from '../src/lib/stats.js';

void test('parses the aggregate CPU line and ignores per-core lines', () => {
  const content = [
    'cpu  100 0 50 1000 10 0 0 0 0 0',
    'cpu0 50 0 25 500 5 0 0 0 0 0',
    'intr 132 0 0 0',
  ].join('\n');

  // user 100 + system 50 are busy; idle 1000 + iowait 10 are not.
  assert.deepEqual(parseProcStat(content), { busy: 150, total: 1160 });
});

void test('rejects a CPU line with too few or non-numeric fields', () => {
  assert.equal(parseProcStat('cpu  1 2 3'), undefined);
  assert.equal(parseProcStat('cpu  1 2 3 x'), undefined);
  assert.equal(parseProcStat('intr 132 0 0'), undefined);
});

void test('converts the busy delta between samples into a percentage', () => {
  const previous = { busy: 150, total: 1160 };
  const current = { busy: 250, total: 1560 };

  // 100 busy jiffies out of 400 total jiffies.
  assert.equal(cpuPercent(previous, current), 25);
});

void test('reports a fully busy guest as one hundred percent', () => {
  assert.equal(
    cpuPercent({ busy: 0, total: 1000 }, { busy: 1000, total: 2000 }),
    100,
  );
});

void test('omits the CPU reading when no time elapsed or counters regressed', () => {
  assert.equal(
    cpuPercent({ busy: 100, total: 1000 }, { busy: 100, total: 1000 }),
    undefined,
  );
  assert.equal(
    cpuPercent({ busy: 200, total: 1000 }, { busy: 100, total: 1200 }),
    undefined,
  );
});

void test('reads total and available memory in bytes', () => {
  const content = [
    'MemTotal:        1048576 kB',
    'MemFree:          200000 kB',
    'MemAvailable:     524288 kB',
  ].join('\n');

  const memory = parseMeminfo(content);

  assert.equal(memory?.totalBytes, 1_073_741_824);
  assert.equal(memory?.availableBytes, 536_870_912);
  assert.equal(
    memory === undefined ? undefined : memoryUsedBytes(memory),
    536_870_912,
  );
});

void test('requires both total and available memory', () => {
  assert.equal(parseMeminfo('MemTotal: 1048576 kB'), undefined);
  assert.equal(parseMeminfo('MemAvailable: 524288 kB'), undefined);
});

void test('reads CPU and memory from one combined guest capture', () => {
  const content = [
    'cpu  100 0 50 1000 10 0 0 0 0 0',
    'MemTotal:        1048576 kB',
    'MemAvailable:     524288 kB',
  ].join('\n');

  assert.deepEqual(parseGuestStats(content), {
    cpu: { busy: 150, total: 1160 },
    memory: { totalBytes: 1_073_741_824, availableBytes: 536_870_912 },
  });
});

void test('leaves sections absent when the guest capture is unreadable', () => {
  assert.deepEqual(parseGuestStats('garbage'), {
    cpu: undefined,
    memory: undefined,
  });
});
