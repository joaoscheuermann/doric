// layout.conversation/v1@1.0.0 (bundle isolation 4a, O8): the bottom split's
// visibility requests. The `layout.workspace/v1` cases moved to the
// `workspace` bundle with their provider in step 4(c)
// (`bundles/desktop/workspace/tests/workspace-service.test.ts`).

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

import { createTestServices } from 'bundle/testing';

import { createLayoutConversation } from '../src/client/services/layout-conversation.js';
import { bottomStore, resetBottom } from '../src/client/stores/bottom.js';
import { LayoutConversationV1 } from '../src/contracts/index.js';

beforeEach(resetBottom);

describe('layout.conversation/v1', () => {
  test('the bottom split shows while any item asks for it', async () => {
    const harness = createTestServices({
      bundle: { id: 'terminal' },
      provide: [createLayoutConversation()],
    });
    const conversation = harness.services.use(LayoutConversationV1);
    const shown = () => bottomStore.getState().visible.size > 0;

    conversation.setBottomVisible('terminal-manual', true);
    conversation.setBottomVisible('other', true);
    conversation.setBottomVisible('terminal-manual', false);
    assert.equal(shown(), true);

    conversation.setBottomVisible('other', false);
    assert.equal(shown(), false);
    await harness.dispose();
  });
});
