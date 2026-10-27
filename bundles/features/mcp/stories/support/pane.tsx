// The MCP pane's elements, mounted the way the layout mounts them: the
// activation's store seeded with a Project's servers, the elements built by
// `defineMcpElements` over the logging `fakeApi` and defined under tags of the
// story's own.

import type { Services } from 'bundle/contracts';
import type { ReactElementInstance } from 'desktop/ui/react-element';
import { useEffect, useRef } from 'react';

import { defineMcpElements } from '../../src/client/elements.js';
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

/**
 * Tags are unique per module instance too: a later preview revision loads this
 * module again in the same document, whose registry keeps the earlier tags.
 */
const instance = Math.random().toString(36).slice(2, 8);
let defined = 0;

/** Builds the pane's elements over a seeded store, under fresh tags. */
const defineFor = ({ projectId, servers }: PaneSetup) => {
  const store = createMcpServersStore();
  store.select(projectId);
  store.setServers(servers);
  const elements = defineMcpElements({ store, api: fakeApi });
  defined += 1;
  customElements.define(
    `mcp-sidebar-story-${instance}-${defined}`,
    elements.sidebar,
  );
  customElements.define(
    `mcp-group-action-story-${instance}-${defined}`,
    elements.groupAction,
  );
  return elements;
};

function Mounted({
  Element,
}: {
  readonly Element: new () => ReactElementInstance;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frame = host.current;
    if (frame === null) return;
    const element = new Element();
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
  const elements = useRef<ReturnType<typeof defineFor> | null>(null);
  elements.current ??= defineFor(setup);
  const { sidebar, groupAction } = elements.current;

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
