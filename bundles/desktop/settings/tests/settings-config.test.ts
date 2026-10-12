// R-9.8: settings.config/v1 is the settings window's one autosave draft: a
// section another bundle draws reads it and writes it through the same
// setter the built-in sections use.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createTestServices } from 'bundle/testing';

import type { Configuration } from '../src/client/domain/config.js';
import {
  createConfigBridge,
  createSettingsConfig,
  SettingsConfigV1,
} from '../src/client/services/settings-config.js';

const draft = (credentialId?: string) =>
  ({
    git: credentialId === undefined ? {} : { credentialId },
  }) as unknown as Configuration;

const setup = () => {
  const bridge = createConfigBridge();
  const harness = createTestServices({
    bundle: { id: 'git' },
    provide: [createSettingsConfig(bridge)],
  });
  return {
    bridge,
    config: harness.services.use(SettingsConfigV1),
    dispose: harness.dispose,
  };
};

describe('settings.config/v1', () => {
  test('there is no draft until the window loaded one, and writes wait for it', async () => {
    const { config, dispose } = setup();
    let called = false;

    assert.equal(config.draft(), undefined);
    config.setDraft((current) => {
      called = true;
      return current;
    });

    assert.equal(called, false);
    await dispose();
  });

  test('a write goes through the window setter and composes with the next one', async () => {
    const { bridge, config, dispose } = setup();
    const written: Configuration[] = [];
    bridge.publish({ draft: draft(), setDraft: (next) => written.push(next) });

    config.setDraft(() => draft('one'));
    config.setDraft((current) => {
      assert.deepEqual(current, draft('one'));
      return draft('two');
    });

    assert.deepEqual(written, [draft('one'), draft('two')]);
    assert.deepEqual(config.draft(), draft('two'));
    await dispose();
  });

  test('subscribers hear each new draft until they dispose', async () => {
    const { bridge, config, dispose } = setup();
    const setDraft = () => undefined;
    let heard = 0;
    const subscription = config.subscribe(() => {
      heard += 1;
    });

    const loaded = draft();
    bridge.publish({ draft: loaded, setDraft });
    bridge.publish({ draft: loaded, setDraft });
    bridge.publish({ draft: draft('one'), setDraft });
    subscription.dispose();
    bridge.publish({ draft: draft('two'), setDraft });

    assert.equal(heard, 2);
    await dispose();
  });
});
