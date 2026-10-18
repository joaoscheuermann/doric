// Stand-ins for the two core elements the settings view draws into. In the
// app the core's `<core-region name="settings.sections">` holds one
// `<settings-link>` per region item and `<core-outlet>` holds the element of
// the route showing; the settings view then portals its nav rows and its
// section into those hosts. A story has no core, so these do the same with
// this bundle's own sections and the story host's navigation. When a real
// core already defines the elements (a Doric window), its own are kept.

import { sectionLink, sections } from '../../src/client/domain/sections.js';
import {
  linkHosts,
  sectionHosts,
  sectionIds,
} from '../../src/client/elements.js';
import { storyNavigation } from './host.js';

const define = (name: string, element: CustomElementConstructor): void => {
  if (customElements.get(name) === undefined)
    customElements.define(name, element);
};

/** Fills `settings.sections` with this bundle's links, in region order. */
class StoryRegion extends HTMLElement {
  connectedCallback(): void {
    this.style.display = 'contents';
    if (this.getAttribute('name') !== 'settings.sections') return;
    if (this.childElementCount > 0) return;
    for (const section of [...sections].sort((a, b) => a.order - b.order)) {
      const link = document.createElement('settings-link');
      Object.assign(link, sectionLink(section).props);
      this.append(link);
    }
  }
}

/** Holds the element of the section the story host's route shows. */
class StoryOutlet extends HTMLElement {
  #subscription: { dispose(): void } | undefined;

  connectedCallback(): void {
    this.style.display = 'contents';
    const navigation = storyNavigation();
    this.#show();
    this.#subscription = navigation?.subscribe(() => this.#show());
  }

  disconnectedCallback(): void {
    this.#subscription?.dispose();
    this.#subscription = undefined;
  }

  #show(): void {
    const path = storyNavigation()?.current()?.path ?? '';
    const id = sectionIds.find((section) => path === `/settings/${section}`);
    const tag = id === undefined ? undefined : `settings-${id}`;
    if (this.firstElementChild?.localName === tag) return;
    this.replaceChildren(
      ...(tag === undefined ? [] : [document.createElement(tag)]),
    );
  }
}

/**
 * Defines the settings elements the view portals into and the core stand-ins
 * that place them. Called from a story's render, never at module load.
 */
export const defineSettingsElements = (): void => {
  define('settings-link', linkHosts.Element);
  for (const id of sectionIds)
    define(`settings-${id}`, sectionHosts[id].Element);
  define('core-region', StoryRegion);
  define('core-outlet', StoryOutlet);
};
