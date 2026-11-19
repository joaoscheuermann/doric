// The default bundle's client part (bundle isolation 5(b), change 2): the
// `default-skill-call` element, defined through `ui/v1`, draws each
// `load_skill` call in the chat's transcript, registered through
// `chat.views/v1` while the chat serves it. Only the chat's types are
// imported; the reference is built here, so no chat code is loaded.

import { type Cleanup, type ClientContext, ref, UiV1 } from 'bundle/contracts';
import type { ChatViews } from 'chat/contracts';

import { defineSkillCallElement, SKILL_CALL_TAG } from './skill-call.js';
import { LOAD_SKILL_TOOL } from './skill-load.js';

const ChatViewsV1 = ref<ChatViews>('chat.views/v1');

export function activate({ services }: ClientContext): Cleanup {
  const defined = services
    .use(UiV1)
    .define(SKILL_CALL_TAG, defineSkillCallElement());

  // A `load_skill` call is a block of its own, outside the activity group,
  // drawn by the element while the chat serves its views (`:1044`).
  const drawing = services.whenAvailable(ChatViewsV1, (views) => {
    const registration = views.registerToolRenderer({
      toolName: LOAD_SKILL_TOOL,
      elementTag: SKILL_CALL_TAG,
      standalone: true,
    });
    return () => registration.dispose();
  });

  return () => {
    drawing.dispose();
    defined.dispose();
  };
}
