// The threads bundle's client part: `<threads-delegated-turn>`, registered as
// chat's renderer for another Thread's input (`chat.delegated-input/v1`); the
// projector that keeps old ask rows from drawing (D30); `<threads-spawn-call>`,
// registered for the `thread-spawn` tool's calls (bundle isolation 5(b)); and
// the sender's record read from `runtime.records/v1` when it is available.

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
import { THREAD_SPAWN_TOOL } from './domain/thread-spawn.js';
import { oldAskProjector } from './old-asks.js';
import { RuntimeRecordsV1, setRecords } from './source.js';
import { defineSpawnCallElement, SPAWN_CALL_TAG } from './spawn-call.js';

export function activate({ services }: ClientContext): Cleanup {
  const ui = services.use(UiV1);
  const element = ui.define(DELEGATED_TURN_TAG, defineDelegatedTurnElement());
  const spawnCall = ui.define(SPAWN_CALL_TAG, defineSpawnCallElement());
  const records = services.whenAvailable(RuntimeRecordsV1, (api) => {
    setRecords(api);
    return () => setRecords(undefined);
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
  // A `thread-spawn` call is a block of its own, outside the activity group,
  // drawn by the element while the chat serves its views (`:1038`). Its own
  // callback, so a refused registration leaves the delegated input's.
  const spawnDrawing = services.whenAvailable(ChatViewsV1, (views) => {
    const registration = views.registerToolRenderer({
      toolName: THREAD_SPAWN_TOOL,
      elementTag: SPAWN_CALL_TAG,
      standalone: true,
    });
    return () => registration.dispose();
  });

  return () => {
    spawnDrawing.dispose();
    renderer.dispose();
    records.dispose();
    spawnCall.dispose();
    element.dispose();
  };
}
