// layout.tabs/v1 (stage 9, §5.6): other bundles open tabs in the workspace's
// tab strip. The tabs belong to the active route's Thread, else to the
// selected Project, exactly as the workspace's own file, diff and terminal
// tabs do; an element tab shows the element `ui/v1` created for it.

import {
  ContractError,
  defineMethod,
  defineService,
  type Ui,
} from 'bundle/contracts';

import {
  LayoutTabsV1,
  layoutTabsMethods,
  type TabRequest,
} from '../../contracts/index.js';
import { workspaceTabsStore } from '../stores/workspace-tabs.js';

export const noTabOwnerMessage = 'No thread or project is selected.';

export interface LayoutTabsOptions {
  readonly ui: Pick<Ui, 'create' | 'dispose'>;
  /** The owner of the active tabs: a Thread id or `project:<id>`. */
  readonly owner: () => string | undefined;
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

export const createLayoutTabs = ({ ui, owner }: LayoutTabsOptions) => {
  const activeOwner = (): string => {
    const current = owner();
    if (current === undefined) {
      throw new ContractError('unavailable', noTabOwnerMessage);
    }
    return current;
  };

  const tabOf = (tabOwner: string, id: string) =>
    workspaceTabsStore
      .getState()
      .threads[tabOwner]?.items.find((tab) => tab.id === id);

  return defineService(LayoutTabsV1, {
    open: defineMethod({
      ...layoutTabsMethods.open,
      execute: (input: TabRequest) =>
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
            title: input.title,
            element,
          });
        }),
    }),
    close: defineMethod({
      ...layoutTabsMethods.close,
      execute: ({ id }: { readonly id: string }) =>
        settled(() => {
          const tabOwner = activeOwner();
          const tab = tabOf(tabOwner, id);
          if (tab === undefined) return;
          workspaceTabsStore.getState().close(tabOwner, id);
          if (tab.kind === 'element') ui.dispose(tab.element);
        }),
    }),
    focus: defineMethod({
      ...layoutTabsMethods.focus,
      execute: ({ id }: { readonly id: string }) =>
        settled(() => {
          const tabOwner = activeOwner();
          if (tabOf(tabOwner, id) === undefined) return;
          workspaceTabsStore.getState().select(tabOwner, id);
        }),
    }),
  });
};
