// The MCP pane's elements, mounted the way the layout mounts them: the
// activation's store seeded with a Project's servers, the elements built by
// `defineMcpElements` over the logging `fakeApi` and defined under tags of the
// story's own.
//
// The tags are picked and defined when an element mounts, never while a story
// renders: React may render a story more than once before it commits (and
// retries a render that threw), and one window may load this module more than
// once (each preview of the stories is a copy of its own), while every copy
// shares the window's one registry. A tag the registry already holds is never
// defined again, so neither can throw `NotSupportedError` from a render.

import type { Services } from 'bundle/contracts';
import type { ReactElementInstance } from 'desktop/ui/react-element';
import { useEffect, useRef, useState } from 'react';

import { defineMcpElements } from '../../src/client/elements.js';
import { createMcpSignIns } from '../../src/client/sign-in.js';
import { createMcpServersStore } from '../../src/client/store.js';
import type { McpServerView } from '../../src/contracts/index.js';
import { fakeApi } from './fixtures.js';

interface PaneSetup {
  /** The selected Project; absent, nothing is selected. */
  readonly projectId?: string;
  /** The servers its watch delivered. */
  readonly servers: readonly McpServerView[];
}

/** The elements read nothing from their services: the store and api carry it all. */
const services: Services = {
  provide: () => {
    throw new Error('The MCP stories provide no services.');
  },
  use: () => {
    throw new Error('The MCP stories reach no contract.');
  },
  whenAvailable: () => ({ dispose: () => undefined }),
};

type ElementClass = new () => ReactElementInstance;

/** The tag each element class was defined under, once it first mounted. */
const tags = new WeakMap<ElementClass, string>();

/** Defines `Element` under the first `mcp-story-<n>` tag the window has free. */
const tagOf = (Element: ElementClass): string => {
  const known = tags.get(Element);
  if (known !== undefined) return known;
  let index = 1;
  while (customElements.get(`mcp-story-${index}`) !== undefined) index += 1;
  const tag = `mcp-story-${index}`;
  customElements.define(tag, Element);
  tags.set(Element, tag);
  return tag;
};

/** Builds the pane's elements over a seeded store; nothing is defined yet. */
const elementsFor = ({ projectId, servers }: PaneSetup) => {
  const store = createMcpServersStore();
  store.select(projectId);
  store.setServers(servers);
  const signIns = createMcpSignIns({ store, api: fakeApi });
  return defineMcpElements({ store, api: fakeApi, signIns });
};

function Mounted({ Element }: { readonly Element: ElementClass }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frame = host.current;
    if (frame === null) return;
    const element = document.createElement(
      tagOf(Element),
    ) as ReactElementInstance;
    element.services = services;
    frame.replaceChildren(element);
    return () => frame.replaceChildren();
  }, [Element]);

  return <div ref={host} className="contents" />;
}

/**
 * The MCP group as the layout's stack draws it: the header with the pane's
 * title and its add control, and the rows below.
 */
export function McpPane({ setup }: { readonly setup: PaneSetup }) {
  const [{ sidebar, groupAction }] = useState(() => elementsFor(setup));

  return (
    <div className="flex flex-col">
      <div className="relative flex h-8 items-center px-2 text-xs font-medium text-sidebar-foreground/70">
        MCP
        <Mounted Element={groupAction} />
      </div>
      <Mounted Element={sidebar} />
    </div>
  );
}
