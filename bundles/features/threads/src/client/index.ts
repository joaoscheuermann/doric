// The threads bundle's client part: `<threads-delegated-turn>`, registered as
// chat's renderer for another Thread's input (`chat.delegated-input/v1`);
// `<threads-ask>`, chat's renderer for an ask (`threads.question/v1`), with the
// projector that draws asks and the live rows that change them; and the
// sender's record read from `layout.workspace/v1` when a layout is available.

import {
  type Cleanup,
  type ClientContext,
  type Disposable,
  HooksV1,
  UiV1,
} from 'bundle/contracts';

import { ASK_TAG, defineAskElement } from './ask.js';
import { noticeThreadUpdate } from './ask-changes.js';
import {
  ChatHooksV1,
  ChatViewsV1,
  DELEGATED_INPUT_BLOCK,
} from './chat-contract.js';
import {
  DELEGATED_TURN_TAG,
  defineDelegatedTurnElement,
} from './delegated-turn.js';
import { ASK_BLOCK, askProjector } from './domain/ask.js';
import { LayoutWorkspaceV1, setWorkspace } from './source.js';

export function activate({ services }: ClientContext): Cleanup {
  const ui = services.use(UiV1);
  const element = ui.define(DELEGATED_TURN_TAG, defineDelegatedTurnElement());
  const askElement = ui.define(ASK_TAG, defineAskElement());
  const workspace = services.whenAvailable(LayoutWorkspaceV1, (api) => {
    setWorkspace(api);
    return () => setWorkspace(undefined);
  });
  const renderer = services.whenAvailable(ChatViewsV1, (views) => {
    const registrations: Disposable[] = [
      views.registerRenderer({
        blockType: DELEGATED_INPUT_BLOCK,
        elementTag: DELEGATED_TURN_TAG,
      }),
      views.registerRenderer({ blockType: ASK_BLOCK, elementTag: ASK_TAG }),
    ];
    try {
      registrations.push(views.registerProjector(askProjector));
    } catch {
      // Another bundle claimed the ask rows first; its projection stands, and
      // the renderer above still draws the ask blocks it makes.
    }
    return () => {
      for (const registration of registrations) registration.dispose();
    };
  });
  const changes = services.use(HooksV1).whenAvailable(ChatHooksV1, (chat) => {
    const registration = chat.onThreadUpdateHook(noticeThreadUpdate);
    return () => registration.dispose();
  });

  return () => {
    changes.dispose();
    renderer.dispose();
    workspace.dispose();
    askElement.dispose();
    element.dispose();
  };
}
