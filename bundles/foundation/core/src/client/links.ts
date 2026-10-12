// Same-origin <a href> clicks navigate through navigation/v1 instead of
// loading a page (stage 9, §4.4). Only a plain primary click on an anchor
// without `target` or `download` is taken; every other click keeps the
// browser's behavior (Electron denies other origins).

import type { Disposable, Navigation } from 'bundle/contracts';

import { sameOrigin } from './origin.js';

const anchorOf = (event: MouseEvent): HTMLAnchorElement | undefined => {
  for (const target of event.composedPath()) {
    if (target instanceof HTMLAnchorElement) {
      return target.hasAttribute('href') ? target : undefined;
    }
  }

  return undefined;
};

export const interceptLinks = (
  navigation: Pick<Navigation, 'navigate'>,
  target: Document = document,
): Disposable => {
  const onClick = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    const anchor = anchorOf(event);

    if (
      anchor === undefined ||
      anchor.hasAttribute('target') ||
      anchor.hasAttribute('download')
    ) {
      return;
    }

    const url = new URL(anchor.href, window.location.href);

    if (!sameOrigin(url)) {
      return;
    }

    event.preventDefault();
    navigation.navigate(`${url.pathname}${url.search}${url.hash}`);
  };

  target.addEventListener('click', onClick);

  return {
    dispose: () => target.removeEventListener('click', onClick),
  };
};
