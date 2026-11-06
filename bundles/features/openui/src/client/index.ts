// The `openui` bundle's client part (conversation-openui.md D29, openui.md
// D24): `<openui-fence>`, registered as chat's renderer of `openui-lang`
// fences while the Generative UI setting is on; the projector that claims
// `openui.answered/v1` rows; the live rows that make a question read its
// state again; and the Generative UI section of the settings window.

import {
  type Cleanup,
  type ClientContext,
  type Disposable,
  HooksV1,
  NavigationV1,
  RegionsV1,
  UiV1,
} from 'bundle/contracts';
import { defineReactElement } from 'desktop/ui/react-element';
import { StrictMode } from 'react';

import { OpenuiSettingV1 } from '../contracts/index.js';
import { noticeThreadUpdate } from './answer-changes.js';
import { answersProjector } from './answers-projector.js';
import { ChatHooksV1, ChatViewsV1 } from './chat-contract.js';
import { createFenceShell, FENCE_ELEMENT_TAG } from './fence-element.js';
import { chunkLoader } from './folds.js';
import {
  defineSettingsElement,
  SETTINGS_PATH,
  SETTINGS_TAG,
  settingsRegion,
} from './settings.js';

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
  disposables.push(ui.define(SETTINGS_TAG, defineSettingsElement()));
  disposables.push(
    services.use(RegionsV1).add(settingsRegion.region, settingsRegion.item),
  );
  disposables.push(
    services.use(NavigationV1).register({
      path: SETTINGS_PATH,
      parent: '/settings',
      create: () => ui.create(SETTINGS_TAG),
    }),
  );

  const views = services.whenAvailable(ChatViewsV1, (chat) => {
    let projector: Disposable | undefined;
    try {
      projector = chat.registerProjector(answersProjector);
    } catch {
      // Another bundle claimed the rows first; its projection stands.
    }

    // The fence renderer exists only while the setting is on (D24).
    let renderer: Disposable | undefined;
    const watch = services.use(OpenuiSettingV1).watch(({ enabled }) => {
      if (enabled && renderer === undefined) {
        renderer = chat.registerFenceRenderer({
          tag: FENCE_TAG,
          elementTag: FENCE_ELEMENT_TAG,
        });
      } else if (!enabled && renderer !== undefined) {
        renderer.dispose();
        renderer = undefined;
      }
    });

    return () => {
      watch.dispose();
      renderer?.dispose();
      renderer = undefined;
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
