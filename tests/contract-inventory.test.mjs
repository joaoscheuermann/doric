import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { checkContractInventory } from './support/contract-inventory.mjs';
import { root } from './support/workspace.mjs';

const fixture = join(root, 'tests', 'fixtures', 'contract-inventory');

const checkFixture = () =>
  checkContractInventory({
    tsconfig: join(fixture, 'tsconfig.json'),
    inventory: join(fixture, 'inventory.md'),
    allowlist: join(fixture, 'allow.json'),
  });

const pairs = (entries) =>
  entries
    .map(({ contract, method }) => `${contract}.${method}`)
    .sort((left, right) => left.localeCompare(right));

// T0.2, contract-inventory.mjs

test('T0.2(a) every contract method that is not plain data has a row in section A of the inventory, and every row names one', async () => {
  const result = await checkContractInventory({
    tsconfig: join(root, 'tsconfig.base.json'),
    inventory: join(
      root,
      'docs',
      'designs',
      'grpc-processes',
      'contract-inventory.md',
    ),
    allowlist: join(root, 'tests', 'contract-inventory-allow.json'),
  });

  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.extra, []);
});

test('T0.2(b) a function member, a brand interface and an unlisted any with no row are missing, each with a reason', async () => {
  const { missing } = await checkFixture();

  assert.deepEqual(pairs(missing), [
    'fixture/v1.loose',
    'fixture/v1.open',
    'fixture/v1.watch',
  ]);
  for (const entry of missing) {
    assert.equal(typeof entry.reason, 'string');
    assert.notEqual(entry.reason.trim(), '');
  }
});

test('T0.2 a row naming a member the check does not flag is extra, and a flagged member with a row is neither missing nor extra', async () => {
  const { missing, extra } = await checkFixture();

  assert.deepEqual(pairs(extra), ['fixture/v1.list']);
  assert.ok(!pairs(missing).includes('fixture/v1.listed'));
});

test('T0.2 an allowlisted any is not missing', async () => {
  const { missing, extra } = await checkFixture();

  assert.ok(!pairs(missing).includes('fixture/v1.allowed'));
  assert.ok(!pairs(extra).includes('fixture/v1.allowed'));
});

test('T0.2 without the allowlist, the allowlisted any is missing', async () => {
  const { missing } = await checkContractInventory({
    tsconfig: join(fixture, 'tsconfig.json'),
    inventory: join(fixture, 'inventory.md'),
  });

  assert.ok(pairs(missing).includes('fixture/v1.allowed'));
});
