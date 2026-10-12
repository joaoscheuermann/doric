// The window's menu context `path` follows its route (stage 9, §4.4): the
// active pattern after every navigation, `null` when no route matches.

import type { Disposable, Log, Menus, Navigation } from 'bundle/contracts';

export const reportMenuContext = (
  navigation: Pick<Navigation, 'current' | 'subscribe'>,
  menus: Pick<Menus, 'setContext'>,
  log: Pick<Log, 'error'>,
): Disposable => {
  let last: string | null | undefined;

  const report = () => {
    const value = navigation.current()?.pattern ?? null;

    if (value === last) {
      return;
    }

    last = value;
    Promise.resolve()
      .then(() => menus.setContext({ key: 'path', value }))
      .catch((error: unknown) => {
        log.error('Could not set the menu context of the window path.', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  const subscription = navigation.subscribe(report);

  report();

  return subscription;
};
