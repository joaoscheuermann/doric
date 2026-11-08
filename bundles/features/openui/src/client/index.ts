// The `openui` bundle's client part (conversation-openui.md D29, openui.md
// D24): `<openui-fence>`, registered as chat's renderer of `openui-lang`
// fences at activation; the projector that claims `openui.answered/v1`
// rows; and the live rows that make a question read its state again.

import {
  type Cleanup,
  type ClientContext,
  type Disposable,
  HooksV1,
  UiV1,
} from 'bundle/contracts';
import { defineReactElement } from 'desktop/ui/react-element';
import { StrictMode } from 'react';

import { noticeThreadUpdate } from './answer-changes.js';
import { answersProjector } from './answers-projector.js';
import { ChatHooksV1, ChatViewsV1 } from './chat-contract.js';
import { createFenceShell, FENCE_ELEMENT_TAG } from './fence-element.js';
import { chunkLoader } from './folds.js';

/** The fence tag `<openui-fence>` draws. */
const FENCE_TAG = 'openui-lang';

export function activate({ services }: ClientContext): Cleanup {
  const ui = services.use(UiV1);
  const disposables: Disposable[] = [];

  disposables.push(
    ui.define(
      FENCE_ELEMENT_TAG,
      defineReactElement<{ view?: unknown }>({
        props: ['view'],
        render: createFenceShell(chunkLoader),
        wrap: () => StrictMode,
      }),
    ),
  );

  const views = services.whenAvailable(ChatViewsV1, (chat) => {
    let projector: Disposable | undefined;
    try {
      projector = chat.registerProjector(answersProjector);
    } catch {
      // Another bundle claimed the rows first; its projection stands.
    }

    // No setting governs the fence renderer any more (D24, stage 4).
    const renderer = chat.registerFenceRenderer({
      tag: FENCE_TAG,
      elementTag: FENCE_ELEMENT_TAG,
    });

    return () => {
      renderer.dispose();
      projector?.dispose();
    };
  });

  const changes = services.use(HooksV1).whenAvailable(ChatHooksV1, (chat) => {
    const registration = chat.onThreadUpdateHook(noticeThreadUpdate);
    return () => registration.dispose();
  });

  return () => {
    changes.dispose();
    views.dispose();
    for (const disposable of disposables.reverse()) disposable.dispose();
  };
}
