// The notifications bundle's client part (no UI): observes chat's live
// Thread updates and reports them to this bundle's desktopMain contract.

import {
  type ClientContext,
  type Disposable,
  HooksV1,
  NavigationV1,
} from 'bundle/contracts';

import { NotificationObservationsV1 } from '../contracts/index.js';
import { ChatHooksV1, createObserver } from './observer.js';

export function activate({ services }: ClientContext): Disposable {
  const observe = createObserver({
    shownThreadId: () => services.use(NavigationV1).current()?.params.threadId,
    windowFocused: () => document.hasFocus(),
    report: (observation) =>
      services.use(NotificationObservationsV1).report(observation),
  });

  return services.use(HooksV1).whenAvailable(ChatHooksV1, (chat) => {
    const registration = chat.onThreadUpdateHook(observe);
    return () => registration.dispose();
  });
}
