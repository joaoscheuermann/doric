// Bundle CSS: one <link rel="stylesheet"> per scheduled client part that ships
// styles, appended to <head> in activation order (spec 19.9).

import type { WindowPart } from './protocol.js';

export const insertBundleStyles = (input: {
  /** Scheduled bundle IDs in activation order. */
  readonly order: readonly string[];
  readonly parts: Readonly<Record<string, WindowPart>>;
  readonly document?: Document;
}): readonly HTMLLinkElement[] => {
  const document = input.document ?? globalThis.document;
  const links: HTMLLinkElement[] = [];

  for (const id of input.order) {
    const styles = input.parts[id]?.styles;

    if (styles === undefined) {
      continue;
    }

    const link = document.createElement('link');

    link.rel = 'stylesheet';
    link.href = styles;
    link.dataset.bundle = id;
    document.head.appendChild(link);
    links.push(link);
  }

  return links;
};
