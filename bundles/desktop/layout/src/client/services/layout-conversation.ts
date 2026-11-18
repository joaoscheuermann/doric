// layout.conversation/v1 (bundle isolation 4a): the `layout.main.bottom`
// visibility requests, over the bottom store `layout.workspace/v1` also sets.

import { defineMethod, defineService } from 'bundle/contracts';

import {
  LayoutConversationV1,
  layoutConversationMethods,
} from '../../contracts/index.js';
import { bottomStore } from '../stores/bottom.js';

/** Provides `layout.conversation/v1`; it never fails at creation. */
export const createLayoutConversation = () =>
  defineService(LayoutConversationV1, {
    setBottomVisible: defineMethod({
      ...layoutConversationMethods.setBottomVisible,
      execute: ([itemId, visible]: [string, boolean]) =>
        bottomStore.getState().set(itemId, visible),
    }),
  });
