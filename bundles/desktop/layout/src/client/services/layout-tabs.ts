// layout.tabs/v1 (stage 9, §5.6): other bundles open tabs in the workspace's
// tab strip. The tabs belong to the active route's Thread, else to the
// selected Project, exactly as the workspace's own file, diff and terminal
// tabs do; an element tab shows the element `ui/v1` created for it. 1.1.0
// (WP-10P, R-9.3): the trigger's icon, aria label and tooltip, closing in a
// named owner, and the current tab with its change notifications. 1.2.0
// (S15): a tab's own menu entries, and `retitle`. layout.tabs/v2 (bundle
// isolation 4a): the owner lives in the tabs store and is named through
// `setOwner`; the trigger's icon is an element (`iconTag`), a tab may ask for
// an open bottom, and `close` and `retitle` can reach every owner.

import {
  ContractError,
  defineMethod,
  defineService,
  type Ui,
} from 'bundle/contracts';

import {
  type CurrentTab,
  LayoutTabsV1,
  LayoutTabsV2,
  type LegacyTabRequest,
  layoutTabsMethods,
  legacyLayoutTabsMethods,
  type TabRequest,
} from '../../contracts/index.js';
import type { WorkspaceTab } from '../domain/workspace-tabs.js';
import { workspaceTabsStore } from '../stores/workspace-tabs.js';
import { watchAll } from './subscription.js';

export const noTabOwnerMessage = 'No thread or project is selected.';

export interface LayoutTabsOptions {
  readonly ui: Pick<Ui, 'create' | 'dispose'>;
}

/**
 * The tab operations are synchronous; the contract answers them as promises,
 * and a refusal is a rejection, never a synchronous throw.
 */
const settled = (operation: () => void): Promise<void> => {
  try {
    operation();
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error);
  }
};

const activeOwner = (): string => {
  const current = workspaceTabsStore.getState().owner;
  if (current === undefined) {
    throw new ContractError('unavailable', noTabOwnerMessage);
  }
  return current;
};

const tabOf = (tabOwner: string, id: string) =>
  workspaceTabsStore
    .getState()
    .threads[tabOwner]?.items.find((tab) => tab.id === id);

/** The operations v1 and v2 share, over the owner the tabs store names. */
const operations = ({ ui }: LayoutTabsOptions) => {
  const dispose = (tab: WorkspaceTab) => {
    if (tab.kind === 'element') ui.dispose(tab.element);
  };
  return {
    open: (input: TabRequest | LegacyTabRequest) =>
      settled(() => {
        const tabOwner = activeOwner();
        const tabs = workspaceTabsStore.getState();
        if (tabOf(tabOwner, input.id) !== undefined) {
          tabs.select(tabOwner, input.id);
          return;
        }
        const element = ui.create(input.tag, input.props);
        tabs.open(tabOwner, {
          kind: 'element',
          id: input.id,
          tag: input.tag,
          title: input.title,
          element,
          ...(input.props === undefined ? {} : { props: input.props }),
          ...('icon' in input && input.icon !== undefined
            ? { icon: input.icon }
            : {}),
          ...('iconTag' in input && input.iconTag !== undefined
            ? { iconTag: input.iconTag }
            : {}),
          ...('openBottom' in input && input.openBottom !== undefined
            ? { openBottom: input.openBottom }
            : {}),
          ...(input.ariaLabel === undefined
            ? {}
            : { ariaLabel: input.ariaLabel }),
          ...(input.tooltip === undefined ? {} : { tooltip: input.tooltip }),
          ...(input.menu === undefined ? {} : { menu: input.menu }),
        });
      }),
    close: ({
      id,
      threadId,
      everyOwner,
    }: {
      readonly id: string;
      readonly threadId?: string;
      readonly everyOwner?: boolean;
    }) =>
      settled(() => {
        if (everyOwner === true) {
          for (const tab of workspaceTabsStore.getState().closeEverywhere(id))
            dispose(tab);
          return;
        }
        const tabOwner = threadId ?? activeOwner();
        const tab = tabOf(tabOwner, id);
        if (tab === undefined) return;
        workspaceTabsStore.getState().close(tabOwner, id);
        dispose(tab);
      }),
    focus: ({ id }: { readonly id: string }) =>
      settled(() => {
        const tabOwner = activeOwner();
        if (tabOf(tabOwner, id) === undefined) return;
        workspaceTabsStore.getState().select(tabOwner, id);
      }),
    retitle: ({
      id,
      title,
      threadId,
      everyOwner,
    }: {
      readonly id: string;
      readonly title: string;
      readonly threadId?: string;
      readonly everyOwner?: boolean;
    }) =>
      settled(() => {
        if (everyOwner === true) {
          workspaceTabsStore.getState().retitleEverywhere(id, title);
          return;
        }
        const tabOwner = threadId ?? activeOwner();
        if (tabOf(tabOwner, id) === undefined) return;
        workspaceTabsStore.getState().retitle(tabOwner, id, title);
      }),
    current: (): CurrentTab | undefined => {
      const { owner, threads } = workspaceTabsStore.getState();
      if (owner === undefined) return undefined;
      const state = threads[owner];
      const tab = state?.items.find((item) => item.id === state.selected);
      if (tab === undefined) return undefined;
      return tab.kind === 'element' && tab.props !== undefined
        ? { id: tab.id, props: tab.props }
        : { id: tab.id };
    },
    // The owner lives in the tabs store, so its changes reach this listener.
    subscribe: (listener: () => void) =>
      watchAll(listener, [(notify) => workspaceTabsStore.subscribe(notify)]),
  };
};

/** Provides `layout.tabs/v2` over the tabs store and its owner. */
export const createLayoutTabs = (options: LayoutTabsOptions) => {
  const tabs = operations(options);
  return defineService(LayoutTabsV2, {
    open: defineMethod({ ...layoutTabsMethods.open, execute: tabs.open }),
    close: defineMethod({ ...layoutTabsMethods.close, execute: tabs.close }),
    focus: defineMethod({ ...layoutTabsMethods.focus, execute: tabs.focus }),
    retitle: defineMethod({
      ...layoutTabsMethods.retitle,
      execute: tabs.retitle,
    }),
    current: defineMethod({
      ...layoutTabsMethods.current,
      execute: tabs.current,
    }),
    subscribe: defineMethod({
      ...layoutTabsMethods.subscribe,
      execute: tabs.subscribe,
    }),
    setOwner: defineMethod({
      ...layoutTabsMethods.setOwner,
      execute: ({ owner }: { readonly owner?: string }) =>
        workspaceTabsStore.getState().setOwner(owner),
    }),
  });
};

/** Provides `layout.tabs/v1` over the same tabs and owner as v2. */
export const createLegacyLayoutTabs = (options: LayoutTabsOptions) => {
  const tabs = operations(options);
  return defineService(LayoutTabsV1, {
    open: defineMethod({ ...legacyLayoutTabsMethods.open, execute: tabs.open }),
    close: defineMethod({
      ...legacyLayoutTabsMethods.close,
      execute: tabs.close,
    }),
    focus: defineMethod({
      ...legacyLayoutTabsMethods.focus,
      execute: tabs.focus,
    }),
    retitle: defineMethod({
      ...legacyLayoutTabsMethods.retitle,
      execute: tabs.retitle,
    }),
    current: defineMethod({
      ...legacyLayoutTabsMethods.current,
      execute: tabs.current,
    }),
    subscribe: defineMethod({
      ...legacyLayoutTabsMethods.subscribe,
      execute: tabs.subscribe,
    }),
  });
};
