// P7: a renderer may not navigate its window anywhere but where it is, and
// may not open windows. Main's own `loadURL` is not renderer-initiated.

import { viewNavigationAllowed } from './view';

export interface GuardedContents {
  getURL(): string;
  on(
    event: 'will-navigate',
    listener: (event: { preventDefault(): void }, url: string) => void,
  ): void;
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
}

export const installNavigationGuard = (contents: GuardedContents): void => {
  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL()) {
      event.preventDefault();
    }
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
};

/**
 * P7 for a view window: it may navigate inside its own origin — the xpra HTML5
 * client redirects itself to `connect.html` on the same origin — and may not
 * navigate away from it, nor open windows. Unlike an app window, the view's
 * document is not the app's, so the only boundary is the origin: a
 * same-origin navigation keeps its URL, a cross-origin one is refused.
 */
export const installViewNavigationGuard = (
  contents: GuardedContents,
  origin: string,
): void => {
  contents.on('will-navigate', (event, url) => {
    if (!viewNavigationAllowed(url, origin)) {
      event.preventDefault();
    }
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
};
