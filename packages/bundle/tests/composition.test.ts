// The composition's structural declarations: what a host requires active
// (`required`) and the choices the host makes between bundles that fill the
// same role (`alternatives`). The kernel reads the schema; the helpers only
// compute the choices the host logs and boots.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type Composition,
  compositionSchema,
  enableAlternatives,
  enabledAlternatives,
  readComposition,
  selectAlternatives,
} from '../src/index.js';

const sandbox = {
  env: 'DORIC_SANDBOX_PROVIDER',
  default: 'docker',
  options: ['docker', 'firecracker'],
};

const composition = (enabled: string[]): Composition =>
  compositionSchema.parse({
    core: 'core',
    enabled,
    alternatives: { sandbox },
  });

void test('a composition without required or alternatives declares none, and its helpers offer none', () => {
  const parsed = compositionSchema.parse({ core: 'core', enabled: ['core'] });

  assert.equal(parsed.required, undefined);
  assert.equal(parsed.alternatives, undefined);
  assert.deepEqual(parsed.providers, {});
  assert.deepEqual(selectAlternatives(parsed, {}), {});
  assert.deepEqual(enabledAlternatives(parsed), {});
  assert.deepEqual(enableAlternatives(parsed, {}), parsed);
});

void test('required and alternatives are parsed strictly', () => {
  const base = { core: 'core', enabled: ['core'] };

  assert.throws(() =>
    compositionSchema.parse({
      ...base,
      required: { contracts: ['runtime/v1'], extra: true },
    }),
  );
  assert.throws(() =>
    compositionSchema.parse({ ...base, required: { contracts: ['runtime'] } }),
  );
  assert.throws(() =>
    compositionSchema.parse({
      ...base,
      alternatives: {
        sandbox: { ...sandbox, default: 'nowhere' },
      },
    }),
  );
  assert.throws(() =>
    compositionSchema.parse({
      ...base,
      alternatives: { Sandbox: sandbox },
    }),
  );
});

void test('an alternative takes the option its variable names, and the default otherwise', () => {
  const chooser = composition(['core']);

  assert.deepEqual(
    selectAlternatives(chooser, { DORIC_SANDBOX_PROVIDER: 'firecracker' }),
    { sandbox: 'firecracker' },
  );
  assert.deepEqual(
    selectAlternatives(chooser, { DORIC_SANDBOX_PROVIDER: 'unknown' }),
    { sandbox: 'docker' },
  );
  assert.deepEqual(selectAlternatives(chooser, {}), { sandbox: 'docker' });
});

void test('enabling a chosen option replaces the default bundle in place and only then', () => {
  const enabled = ['core', 'docker', 'files'];
  const chooser = composition(enabled);

  assert.deepEqual(
    enableAlternatives(chooser, { sandbox: 'firecracker' }).enabled,
    ['core', 'firecracker', 'files'],
  );
  assert.deepEqual(
    enableAlternatives(chooser, { sandbox: 'docker' }).enabled,
    enabled,
  );
  // An option already enabled is not listed twice.
  assert.deepEqual(
    enableAlternatives(composition(['docker', 'firecracker']), {
      sandbox: 'firecracker',
    }).enabled,
    ['firecracker'],
  );
});

void test('the alternatives an enabled set names are the single enabled option, else the default', () => {
  const choose = (enabled: string[]) =>
    enabledAlternatives(composition(enabled));

  assert.deepEqual(choose(['core', 'docker']), { sandbox: 'docker' });
  assert.deepEqual(choose(['core', 'firecracker']), { sandbox: 'firecracker' });
  assert.deepEqual(choose(['core', 'docker', 'firecracker']), {
    sandbox: 'docker',
  });
  assert.deepEqual(choose(['core']), { sandbox: 'docker' });
});

void test('the shipped composition requires the five structural contracts and the transport, and offers the sandbox alternative', async () => {
  const shipped = await readComposition('agents/doric/composition.json');

  assert.deepEqual(shipped.required, {
    contracts: [
      'runtime/v1',
      'executor/v1',
      'sandbox/v1',
      'models/v1',
      'host-config/v1',
    ],
    bundles: ['transport'],
  });
  assert.deepEqual(shipped.alternatives, {
    sandbox: {
      env: 'DORIC_SANDBOX_PROVIDER',
      default: 'docker',
      options: ['docker', 'firecracker'],
    },
  });
  assert.deepEqual(enabledAlternatives(shipped), { sandbox: 'docker' });
});
