// The application menu from a skeleton (section 18.1): role entries are
// expanded by Electron itself, so labels, accelerators and roles are
// Electron's [S8-14]; contributed items follow a separator in their menu.

import type { MenuSkeleton, MenuWhen } from 'bundle/contracts';
import type { Menu, MenuItem, MenuItemConstructorOptions } from 'electron';

/** An item a bundle registered through `menus/v1.addItem`. */
export interface RegisteredItem {
  readonly id: string;
  /** `app/<menu>` or `dock`. */
  readonly location: string;
  readonly command: string;
  readonly label: string;
  readonly when?: MenuWhen;
  readonly order?: number;
  /** Activation order of its owner, for ties of `order`. */
  readonly sequence: number;
}

export interface RegisteredBinding {
  readonly command: string;
  readonly key: string;
  readonly when?: MenuWhen;
}

/** The skeleton entry IDs contributed items address as `app/<id>`. */
const menuIdOf = (location: string): string | undefined =>
  location.startsWith('app/') ? location.slice('app/'.length) : undefined;

const byOrder = (left: RegisteredItem, right: RegisteredItem): number =>
  (left.order ?? 0) - (right.order ?? 0) || left.sequence - right.sequence;

export interface MenuTemplateInput {
  readonly skeleton: MenuSkeleton;
  readonly items: readonly RegisteredItem[];
  readonly bindings: readonly RegisteredBinding[];
  readonly platform: NodeJS.Platform;
  readonly dispatch: (command: string) => void;
  /** Electron's own submenu of a role, freshly built (`Menu.buildFromTemplate([{ role }])`). */
  readonly expand: (role: string) => Menu;
  readonly item: (options: MenuItemConstructorOptions) => MenuItem;
}

const contributed = (
  items: readonly RegisteredItem[],
  bindings: readonly RegisteredBinding[],
  dispatch: (command: string) => void,
): MenuItemConstructorOptions[] =>
  [...items].sort(byOrder).map((item) => {
    const binding = bindings.find(
      (candidate) => candidate.command === item.command,
    );

    return {
      id: item.id,
      label: item.label,
      ...(binding === undefined
        ? {}
        : { accelerator: binding.key, registerAccelerator: false }),
      click: () => dispatch(item.command),
    };
  });

/**
 * The menu template: one entry per skeleton entry, `appMenu` only on macOS,
 * `help` only with contributed items, and each menu's contributed items
 * after a separator.
 */
export const menuTemplate = (
  input: MenuTemplateInput,
): MenuItemConstructorOptions[] => {
  const template: MenuItemConstructorOptions[] = [];
  const itemsFor = (id: string) =>
    input.items.filter((item) => menuIdOf(item.location) === id);

  for (const entry of input.skeleton) {
    if (entry.role === 'appMenu' && input.platform !== 'darwin') {
      continue;
    }

    const extra = contributed(
      itemsFor(entry.id),
      input.bindings,
      input.dispatch,
    );
    const nested =
      entry.submenu === undefined
        ? []
        : menuTemplate({ ...input, skeleton: entry.submenu });

    // Electron's default menu has no Help menu [S8-15, revised]: a help entry
    // appears only once a bundle contributes to it.
    if (entry.role === 'help') {
      if (extra.length > 0 || nested.length > 0) {
        template.push({
          role: 'help',
          submenu: [
            ...nested,
            ...(nested.length > 0 && extra.length > 0
              ? [{ type: 'separator' as const }]
              : []),
            ...extra,
          ],
        });
      }

      continue;
    }

    if (entry.role !== undefined) {
      if (extra.length === 0 && nested.length === 0) {
        template.push({
          role: entry.role as MenuItemConstructorOptions['role'],
        });
        continue;
      }

      // The role's own submenu is expanded by Electron, then extended.
      const submenu = input.expand(entry.role);

      for (const options of [
        ...nested,
        { type: 'separator' as const },
        ...extra,
      ]) {
        submenu.append(input.item(options));
      }

      template.push({
        role: entry.role as MenuItemConstructorOptions['role'],
        submenu,
      });
      continue;
    }

    template.push({
      id: entry.id,
      label: entry.label,
      submenu: [
        ...nested,
        ...(extra.length > 0 && nested.length > 0
          ? [{ type: 'separator' as const }]
          : []),
        ...extra,
      ],
    });
  }

  return template;
};
