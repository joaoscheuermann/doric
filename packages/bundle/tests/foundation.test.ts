import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AppHooksV1,
  HooksV1,
  type HostContext,
} from '../src/contracts/index.js';
import { embedded, manifest, withRoot } from './support/fixtures.js';
import { reasonCodes, start, states } from './support/host.js';
import { minimalCore } from './support/minimal-core.js';

void test('a chosen hooks/v1 provider activates in the foundation and receives every hooks call', async () => {
  await withRoot(async (root) => {
    const calls: { method: string; caller: string; contract: string }[] = [];
    const seen: string[] = [];
    const { platform } = await start({
      bundlesPath: root,
      composition: {
        enabled: ['mincore', 'myhooks'],
        providers: { 'hooks/v1': 'myhooks' },
      },
      embedded: [
        minimalCore({ id: 'myhooks', provides: ['hooks/v1'], calls }),
        minimalCore({
          extra: ({ services }: HostContext) => {
            services
              .use(HooksV1)
              .use(AppHooksV1)
              .onActivateHook(({ bundleId }) => {
                seen.push(bundleId);
              });
          },
        }),
        embedded(manifest('later'), () => undefined),
      ],
    });
    const catalog = platform.catalog();

    assert.equal(platform.mode, 'normal');
    assert.deepEqual(catalog.order, ['myhooks', 'mincore', 'later']);
    assert.equal(
      catalog.bundles.find(({ id }) => id === 'myhooks')?.phase,
      'foundation',
    );
    assert.deepEqual(
      catalog.contracts
        .find(({ id }) => id === 'hooks/v1')
        ?.providers.map(({ bundleId }) => bundleId),
      ['myhooks'],
    );
    assert.ok(
      calls.some(
        ({ method, caller, contract }) =>
          method === 'define' &&
          caller === 'doric' &&
          contract === AppHooksV1.id,
      ),
    );
    assert.ok(
      calls.some(
        ({ method, caller }) => method === 'register' && caller === 'mincore',
      ),
    );
    assert.deepEqual(seen, ['mincore', 'later']);

    await platform.stop();
  });
});

void test('a second hooks/v1 provider without a choice is quarantined; core stays active', async () => {
  await withRoot(async (root) => {
    const { platform } = await start({
      bundlesPath: root,
      composition: { enabled: ['mincore', 'otherhooks'] },
      embedded: [
        minimalCore(),
        minimalCore({ id: 'otherhooks', provides: ['hooks/v1'] }),
      ],
    });

    assert.equal(states(platform).mincore, 'active');
    assert.deepEqual(reasonCodes(platform, 'otherhooks'), [
      'unchosen_provider',
    ]);

    await platform.stop();
  });
});

void test('a chosen foundation provider that fails sends the host to recovery', async () => {
  await withRoot(async (root) => {
    const { platform } = await start({
      bundlesPath: root,
      composition: {
        enabled: ['mincore', 'myhooks'],
        providers: { 'hooks/v1': 'myhooks' },
      },
      embedded: [
        minimalCore({
          id: 'myhooks',
          provides: ['hooks/v1'],
          failActivate: true,
        }),
        minimalCore(),
      ],
    });

    assert.equal(platform.mode, 'recovery');
    assert.equal(states(platform).mincore, 'inactive');

    await platform.stop();
  });
});
