// The layout bound to the fake host for one story: the stores start over,
// the story's seeds go in, `activate` runs with the fake services, and the
// children render once all of it is in place. Leaving the story runs the
// activation's cleanup, so the next story starts from nothing.

import { RegionsV1 } from 'bundle/contracts';
import { type ReactNode, useLayoutEffect, useState } from 'react';

import type { WorkspaceTab } from '../../src/client/domain/workspace-tabs.js';
import { activate } from '../../src/client/index.js';
import { bottomStore } from '../../src/client/stores/bottom.js';
import { panelStore } from '../../src/client/stores/panel.js';
import { registerPane } from '../../src/client/stores/stack.js';
import { workspaceTabsStore } from '../../src/client/stores/workspace-tabs.js';
import { LayoutTabsV2 } from '../../src/contracts/index.js';
import {
  appRegions,
  createFakeHost,
  type FakeHost,
  type HostOptions,
  type StackPane,
  screenPane,
} from './fake-host.js';
import { placeholderElement } from './placeholder.js';
import { defineStoryElements } from './story-elements.js';

/** A tab another bundle opened, drawn by a stand-in for its element. */
export interface TabSeed {
  readonly id: string;
  readonly title: string;
  readonly tag: string;
  /** `layout.tabs/v2`: the element drawn as the trigger's icon. */
  readonly iconTag?: string;
  /** `layout.tabs/v2`: the viewer card draws no bottom padding under it. */
  readonly openBottom?: boolean;
  readonly props?: Readonly<Record<string, unknown>>;
}

export interface LayoutFixture extends HostOptions {
  /** Open tabs by owner (a Thread id or `project:<id>`); the last is selected. */
  readonly tabs?: Readonly<Record<string, readonly TabSeed[]>>;
  /** The Project panel's selected view; absent, none, as `layout.panel/v3` starts. */
  readonly panel?: { readonly active?: string };
  /** Whether an item asked for the `shell.conversation.bottom` split. */
  readonly bottom?: boolean;
  /** Sidebar groups other bundles add below the Threads list. */
  readonly panes?: readonly StackPane[];
  /**
   * The tab owner the frame shows, as `workspace` names it through
   * `layout.tabs/v2.setOwner` (a Thread id or `project:<id>`); absent, none.
   */
  readonly owner?: string;
}

const tabsOf = (
  seeds: Readonly<Record<string, readonly TabSeed[]>> | undefined,
) =>
  Object.fromEntries(
    Object.entries(seeds ?? {}).map(([owner, list]) => {
      const items = list.map(
        (seed): WorkspaceTab => ({
          kind: 'element',
          id: seed.id,
          tag: seed.tag,
          title: seed.title,
          element: placeholderElement(seed.tag, seed.props, seed.title),
          ...(seed.props === undefined ? {} : { props: seed.props }),
          ...(seed.iconTag === undefined ? {} : { iconTag: seed.iconTag }),
          ...(seed.openBottom === undefined
            ? {}
            : { openBottom: seed.openBottom }),
          ariaLabel: seed.title,
          tooltip: seed.title,
        }),
      );
      return [owner, { items, selected: items.at(-1)?.id }];
    }),
  );

let unbindCurrent: (() => void) | undefined;

/**
 * Starts the stores over, seeds them from `fixture` and activates the layout
 * on a fake host built from it. Returns the unbind, which runs the
 * activation's cleanup once; binding again first unbinds what is bound.
 */
export const bindLayout = (
  fixture: LayoutFixture,
): FakeHost & {
  readonly unbind: () => void;
} => {
  unbindCurrent?.();
  const created = createFakeHost({ regions: appRegions, ...fixture });
  workspaceTabsStore.setState({ threads: tabsOf(fixture.tabs) });
  defineStoryElements(created);

  const deactivate = activate({ services: created.services });
  // The owner `workspace` would name for the route (step 4(c)): the shell
  // follows no route for it any more.
  created.services
    .use(LayoutTabsV2)
    .setOwner(fixture.owner === undefined ? {} : { owner: fixture.owner });
  // The `account` bundle's item in `shell.window.actions` (step 4(b),
  // decision O1): the fake `ui/v1` draws `account-status` as a stand-in
  // button named "Account", so the frame's two places for the slot show it.
  const account = created.services.use(RegionsV1).add('shell.window.actions', {
    id: 'account',
    tag: 'account-status',
  });
  const panes = (fixture.panes ?? [screenPane]).map(registerPane);
  panelStore.setState({ active: fixture.panel?.active });
  if (fixture.bottom) bottomStore.getState().set('terminals', true);

  const unbind = () => {
    if (unbindCurrent !== unbind) return;
    unbindCurrent = undefined;
    account.dispose();
    for (const pane of panes) pane.dispose();
    void deactivate();
    workspaceTabsStore.setState({ threads: {} });
  };
  unbindCurrent = unbind;
  return { ...created, unbind };
};

const noFixture: LayoutFixture = {};

/**
 * Binds the layout to a fake host built from `fixture`, then renders. Pass a
 * fixture defined once (module scope), not a literal built on every render.
 */
export function LayoutHost({
  fixture = noFixture,
  children,
}: {
  readonly fixture?: LayoutFixture;
  readonly children: ReactNode;
}) {
  const [host, setHost] = useState<FakeHost>();

  useLayoutEffect(() => {
    const bound = bindLayout(fixture);
    setHost(bound);
    return () => {
      setHost(undefined);
      bound.unbind();
    };
  }, [fixture]);

  return host === undefined ? null : children;
}
