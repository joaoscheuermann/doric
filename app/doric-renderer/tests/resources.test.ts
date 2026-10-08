/**
 * The resource monitor's rules, stated as the strings and verdicts they produce
 * rather than through the component, so the formatting and the thresholds are
 * covered without a DOM, a host or a clock.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  bytesLabel,
  type CpuSustain,
  cpuLabel,
  cpuSustained,
  freshnessLabel,
  isSaturated,
  memoryLabel,
  type ProjectResourcesResult,
  resourceNotice,
  severity,
} from '../src/domain/resources';

const gib = 1024 ** 3;
const mib = 1024 ** 2;

describe('bytesLabel', () => {
  test('uses the largest unit and keeps a tenth while it is significant', () => {
    assert.equal(bytesLabel(1.5 * gib), '1.5 GiB');
    assert.equal(bytesLabel(512 * mib), '512 MiB');
  });

  test('says nothing above zero as zero', () => {
    assert.equal(bytesLabel(0), '0 B');
    assert.equal(bytesLabel(Number.NaN), '0 B');
  });
});

describe('memoryLabel', () => {
  test("joins a used/limit pair under the limit's unit", () => {
    assert.equal(memoryLabel(0.3 * gib, 2 * gib), '0.3 / 2 GiB');
    assert.equal(memoryLabel(512 * mib, 2 * gib), '0.5 / 2 GiB');
  });

  test('a missing half is said rather than guessed', () => {
    assert.equal(memoryLabel(512 * mib), '512 MiB');
    assert.equal(memoryLabel(undefined, 2 * gib), '—');
    assert.equal(memoryLabel(), '—');
  });
});

describe('cpuLabel', () => {
  test('rounds a fraction to a percentage', () => {
    assert.equal(cpuLabel(15), '15%');
    assert.equal(cpuLabel(14.6), '15%');
  });

  test('an unmeasured cpu is a dash', () => {
    assert.equal(cpuLabel(), '—');
    assert.equal(cpuLabel(Number.NaN), '—');
  });
});

describe('resourceNotice', () => {
  test('a pending lease is preparing', () => {
    assert.equal(
      resourceNotice({ status: 'pending' }),
      'Preparing environment…',
    );
  });

  test('a terminal lease state is unavailable', () => {
    for (const status of ['missing', 'unavailable', 'expired'] as const) {
      assert.equal(resourceNotice({ status }), 'Environment unavailable');
    }
  });

  test('a readable container is a provider without stats', () => {
    const provider: ProjectResourcesResult = {
      status: 'ready',
      container: { status: 'unavailable', at: '2020-01-01T00:00:00.000Z' },
    };
    assert.equal(
      resourceNotice(provider),
      'Resources unavailable in this provider',
    );
  });

  test('a measured container explains nothing', () => {
    const ready: ProjectResourcesResult = {
      status: 'ready',
      container: { status: 'ready', at: '2020-01-01T00:00:00.000Z' },
    };
    assert.equal(resourceNotice(ready), undefined);
    assert.equal(resourceNotice(undefined), undefined);
  });
});

describe('saturation', () => {
  test('memory at the limit ratio warns and just below does not', () => {
    assert.equal(
      isSaturated({ memoryUsedBytes: 850, memoryLimitBytes: 1000 }),
      true,
    );
    assert.equal(
      isSaturated({ memoryUsedBytes: 849, memoryLimitBytes: 1000 }),
      false,
    );
  });

  test('sustained cpu warns, a missing ratio with it does not', () => {
    assert.equal(isSaturated({ cpuSustained: true }), true);
    assert.equal(isSaturated({ cpuSustained: false }), false);
    assert.equal(isSaturated({}), false);
  });

  test('severity names the tone a value wears', () => {
    assert.equal(
      severity({ memoryUsedBytes: 900, memoryLimitBytes: 1000 }),
      'warning',
    );
    assert.equal(severity({ cpuSustained: true }), 'warning');
    assert.equal(
      severity({ memoryUsedBytes: 100, memoryLimitBytes: 1000 }),
      'normal',
    );
  });
});

describe('cpuSustained', () => {
  const start: CpuSustain = { count: 0, sustained: false };

  test('three consecutive hot readings make it sustained', () => {
    let state = cpuSustained(start, 91);
    assert.deepEqual(state, { count: 1, sustained: false });
    state = cpuSustained(state, 95);
    assert.deepEqual(state, { count: 2, sustained: false });
    state = cpuSustained(state, 90);
    assert.deepEqual(state, { count: 3, sustained: true });
  });

  test('a cold reading, or none, breaks the run', () => {
    assert.deepEqual(cpuSustained({ count: 2, sustained: false }, 40), start);
    assert.deepEqual(
      cpuSustained({ count: 2, sustained: false }, undefined),
      start,
    );
  });

  test('a single hot reading is a spike, not a warning', () => {
    assert.equal(cpuSustained(start, 99).sustained, false);
  });
});

describe('freshnessLabel', () => {
  test('says how long ago a reading was taken', () => {
    assert.equal(
      freshnessLabel(
        '2020-01-01T00:00:00.000Z',
        new Date('2020-01-01T00:00:02.000Z'),
      ),
      'Updated 2s ago',
    );
  });

  test('a reading without a valid time says nothing', () => {
    assert.equal(freshnessLabel('not-a-date'), '');
  });
});
