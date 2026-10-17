// Mounts one of the bundle's custom elements the way `ui/v1` does: the
// class is defined under a story-only tag (once per window), and the
// element receives its listed properties and then the services it renders
// with, which mounts its own React root in its light DOM.

import type { Services } from 'bundle/contracts';
import { createElement, useCallback } from 'react';

type ElementClass = new () => HTMLElement & { services: Services };

const noProperties: Readonly<Record<string, unknown>> = {};

export function ElementHost({
  tag,
  element,
  services,
  properties = noProperties,
}: {
  /** A story-only tag, so the story never collides with the window's. */
  readonly tag: `${string}-${string}`;
  readonly element: ElementClass;
  readonly services: Services;
  readonly properties?: Readonly<Record<string, unknown>>;
}) {
  if (customElements.get(tag) === undefined) {
    customElements.define(tag, element);
  }
  const attach = useCallback(
    (node: HTMLElement | null) => {
      if (node === null) return;
      Object.assign(node, properties);
      (node as HTMLElement & { services: Services }).services = services;
    },
    [properties, services],
  );
  return createElement(tag, { ref: attach });
}
