// P7: a renderer may not navigate its window anywhere but where it is, and
// may not open windows. Main's own `loadURL` is not renderer-initiated.
// A subframe of an app window is a preview frame
// (docs/architecture/bundles/papercraft/isolamento.md): it may only be at the
// frame document, whoever starts the navigation — the shell setting `src` or
// the Project's code in the frame.

import { isFrameDocumentUrl } from '../protocol/frame';
import { viewNavigationAllowed } from './view';

export interface GuardedContents {
  getURL(): string;
  on(
    event: 'will-navigate',
    listener: (event: { preventDefault(): void }, url: string) => void,
  ): void;
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
}

/** An app window's contents, whose subframes are preview frames. */
export interface GuardedAppContents extends GuardedContents {
  on(
    event: 'will-navigate',
    listener: (event: { preventDefault(): void }, url: string) => void,
  ): void;
  on(
    event: 'will-frame-navigate',
    listener: (details: {
      readonly url: string;
      readonly isMainFrame: boolean;
      preventDefault(): void;
    }) => void,
  ): void;
}

export const installNavigationGuard = (contents: GuardedAppContents): void => {
  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL()) {
      event.preventDefault();
    }
  });
  // `will-navigate` covers the main frame; this covers every subframe.
  contents.on('will-frame-navigate', (details) => {
    if (!details.isMainFrame && !isFrameDocumentUrl(details.url)) {
      details.preventDefault();
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
