// The threads bundle's client part: `<threads-delegated-turn>`, registered as
// chat's renderer for another Thread's input (`chat.delegated-input/v1`); the
// projector that keeps old ask rows from drawing (D30); and the sender's
// record read from `layout.workspace/v1` when a layout is available.

import {
  type Cleanup,
  type ClientContext,
  type Disposable,
  UiV1,
} from 'bundle/contracts';

import { ChatViewsV1, DELEGATED_INPUT_BLOCK } from './chat-contract.js';
import {
  DELEGATED_TURN_TAG,
  defineDelegatedTurnElement,
} from './delegated-turn.js';
import { oldAskProjector } from './old-asks.js';
import { LayoutWorkspaceV1, setWorkspace } from './source.js';

export function activate({ services }: ClientContext): Cleanup {
  const ui = services.use(UiV1);
  const element = ui.define(DELEGATED_TURN_TAG, defineDelegatedTurnElement());
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
    ];
    try {
      registrations.push(views.registerProjector(oldAskProjector));
    } catch {
      // Another bundle claimed the old ask rows first; its projection stands.
    }
    return () => {
      for (const registration of registrations) registration.dispose();
    };
  });

  return () => {
    renderer.dispose();
    workspace.dispose();
    element.dispose();
  };
}
