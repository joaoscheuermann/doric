// One of the bundle's custom elements in a story: the tag defined once per
// window (the activation does it with `ui/v1` in the app), then the story
// host and the element's properties set on the instance, as `ui/v1.create`
// sets them. The elements draw no React: React only places the tag.

import type { Services } from 'bundle/contracts';
import { createElement, useEffect, useRef, useState } from 'react';

import { type ArtifactsHostOptions, artifactsHost } from './host.js';

export function CustomElement({
  tag,
  define,
  host,
  properties,
  services: given,
}: {
  readonly tag: string;
  readonly define: () => CustomElementConstructor;
  readonly host?: ArtifactsHostOptions;
  readonly properties?: Readonly<Record<string, unknown>>;
  /** No services at all: the element as a window without the host. */
  readonly services?: null;
}) {
  if (customElements.get(tag) === undefined)
    customElements.define(tag, define());

  const [services] = useState<Services | undefined>(() =>
    given === null ? undefined : artifactsHost(host),
  );
  const element = useRef<HTMLElement & { services?: Services }>(null);

  useEffect(() => {
    const node = element.current;

    if (node === null) return;

    Object.assign(node, properties);
    if (services !== undefined) node.services = services;
  }, [services, properties]);

  return createElement(tag, { ref: element });
}
