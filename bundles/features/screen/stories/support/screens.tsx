// The Screens pane's elements, mounted the way the layout mounts them: the
// activation's mirror store seeded with views, the elements built by
// `defineScreenElements` and defined under a tag of the story's own, and
// fake `screen.views/v1` and `layout.workspace/v1` services in place of the
// desktop part and the layout.

import type { Services } from 'bundle/contracts';
import { useEffect, useRef } from 'react';

import { defineScreenElements } from '../../src/client/elements.js';
import type {
  LayoutWorkspace,
  WorkspaceSelection,
} from '../../src/client/peers.js';
import { createScreenViewsStore } from '../../src/client/store.js';
import type { ScreenView, ScreenViews } from '../../src/contracts/index.js';

export interface ScreensSetup {
  /** Every view the desktop part mirrors, of any Project. */
  readonly views: readonly ScreenView[];
  /** The workspace's selection; absent, no layout is active. */
  readonly selection?: WorkspaceSelection;
  /** Whether the desktop part serves `screen.views/v1` (default `true`). */
  readonly desktop?: boolean;
}

const fakeScreens = (views: readonly ScreenView[]): ScreenViews => {
  const log = (action: string) => (viewId: string) => {
    console.info(`screen.views/v1.${action}(${viewId})`);
    return Promise.resolve();
  };
  return {
    list: () => Promise.resolve(views),
    add: (input) => {
      console.info('screen.views/v1.add', input);
      return Promise.resolve({
        id: 'view-new',
        label: input.label ?? input.projectId,
        projectId: input.projectId,
        status: { kind: 'waiting' },
      });
    },
    remove: log('remove'),
    open: log('open'),
    retry: log('retry'),
    deliver: () => Promise.resolve(),
    watch: () => ({ dispose: () => undefined }),
  };
};

const fakeWorkspace = (selection: WorkspaceSelection): LayoutWorkspace => ({
  selectedThread: () => selection.thread,
  // The layout builds a new record on every call; the pane reads its fields.
  selection: () => ({ ...selection }),
  subscribe: () => ({ dispose: () => undefined }),
});

const servicesOf = (setup: ScreensSetup): Services => {
  const apis: Record<string, unknown> = {};
  if (setup.desktop !== false) {
    apis['screen.views/v1'] = fakeScreens(setup.views);
  }
  if (setup.selection !== undefined) {
    apis['layout.workspace/v1'] = fakeWorkspace(setup.selection);
  }
  return {
    provide: () => {
      throw new Error('The screen stories provide no services.');
    },
    use: ((contract: { readonly id: string }) => {
      const api = apis[contract.id];
      if (api === undefined) {
        throw new Error(`The screen stories do not provide ${contract.id}.`);
      }
      return api;
    }) as Services['use'],
    whenAvailable: ((
      contract: { readonly id: string },
      callback: (api: unknown, provider: unknown) => unknown,
    ) => {
      const api = apis[contract.id];
      const cleanup =
        api === undefined
          ? undefined
          : callback(api, { bundleId: 'stories', version: '1.0.0' });
      return {
        dispose: () => {
          if (typeof cleanup === 'function') cleanup();
        },
      };
    }) as Services['whenAvailable'],
  };
};

let defined = 0;

/** Builds the pane's elements over a seeded store, under fresh tags. */
const defineFor = (setup: ScreensSetup) => {
  const store = createScreenViewsStore();
  store.set(setup.views);
  const elements = defineScreenElements({ store });
  defined += 1;
  const sidebar = `screen-sidebar-story-${defined}`;
  const groupAction = `screen-group-action-story-${defined}`;
  customElements.define(sidebar, elements.sidebar);
  customElements.define(groupAction, elements.groupAction);
  return { sidebar, groupAction, services: servicesOf(setup) };
};

function Mounted({
  tag,
  services,
}: {
  readonly tag: string;
  readonly services: Services;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frame = host.current;
    if (frame === null) return;
    const element = document.createElement(tag) as HTMLElement & {
      services: Services;
    };
    element.services = services;
    frame.replaceChildren(element);
    return () => frame.replaceChildren();
  }, [tag, services]);

  return <div ref={host} className="contents" />;
}

/**
 * The Screens group as the layout's stack draws it: the header with the
 * pane's title and its add control, and the rows below.
 */
export function ScreensPane({ setup }: { readonly setup: ScreensSetup }) {
  const elements = useRef<ReturnType<typeof defineFor> | null>(null);
  elements.current ??= defineFor(setup);
  const { sidebar, groupAction, services } = elements.current;

  return (
    <div className="flex flex-col">
      <div className="relative flex h-8 items-center px-2 text-xs font-medium text-sidebar-foreground/70">
        Screens
        <Mounted tag={groupAction} services={services} />
      </div>
      <Mounted tag={sidebar} services={services} />
    </div>
  );
}
