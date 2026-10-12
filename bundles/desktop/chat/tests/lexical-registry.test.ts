// `chat.lexical/v1`: registrations are accepted until the window's first
// conversation editor freezes the list, then refused with `frozen`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isContractError } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';

import { createChatLexical } from '../src/client/services/lexical.js';
import { ChatLexicalV1 } from '../src/contracts/index.js';

class FirstNode {}
class SecondNode {}
class LateNode {}

const setup = () => {
  const lexical = createChatLexical();
  const test = createTestServices({
    bundle: { id: 'extension' },
    provide: [lexical.service],
  });
  return {
    lexical,
    api: test.services.use(ChatLexicalV1),
    dispose: test.dispose,
  };
};

describe('chat.lexical/v1', () => {
  test('nodes and extensions registered before the first editor are in the frozen list', async () => {
    const { lexical, api, dispose } = setup();
    api.registerNodes([FirstNode as never]);
    const removed = api.registerNodes([SecondNode as never]);
    api.registerExtension({ name: '@test/extension' } as never);
    removed.dispose();

    const frozen = lexical.registry.freeze();

    assert.deepEqual(frozen.nodes, [FirstNode]);
    assert.deepEqual(
      frozen.extensions.map((extension) => extension.name),
      ['@test/extension'],
    );
    await dispose();
  });

  test('after the freeze, registrations fail with frozen and the list stays', async () => {
    const { lexical, api, dispose } = setup();
    const kept = api.registerNodes([FirstNode as never]);
    lexical.registry.freeze();

    assert.throws(
      () => api.registerNodes([LateNode as never]),
      (error) => isContractError(error) && error.code === 'frozen',
    );
    assert.throws(
      () => api.registerExtension({ name: '@test/late' } as never),
      (error) => isContractError(error) && error.code === 'frozen',
    );
    kept.dispose();
    assert.deepEqual(lexical.registry.freeze().nodes, [FirstNode]);
    await dispose();
  });
});
