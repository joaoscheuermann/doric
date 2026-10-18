// `doric.menus/v1` in main: the skeleton of each generation, the items and
// keybindings bundles registered (keyed by generation and owner), the menu
// context of each window, and the application menu built from them.

import {
  type Caller,
  ContractError,
  type MenuSkeleton,
  type MenuWhen,
} from 'bundle/contracts';
import type { ShellKeybinding } from 'desktop/protocol';
import type { Menu, MenuItem, MenuItemConstructorOptions } from 'electron';

import type {
  WindowContext,
  WindowEntry,
  WindowRegistry,
} from '../windows/registry';
import {
  menuTemplate,
  type RegisteredBinding,
  type RegisteredItem,
} from './skeleton';

export interface MenuItemRequest {
  readonly id: string;
  readonly location: string;
  readonly command: string;
  readonly label: string;
  readonly when?: MenuWhen;
  readonly order?: number;
  readonly owner: Caller;
}

export interface KeybindingRequest {
  readonly command: string;
  readonly key: string;
  readonly when?: MenuWhen;
  readonly owner: Caller;
}

interface Owned<T> {
  readonly generation: number;
  readonly owner: string;
  readonly value: T;
}

/** Whether a `when` condition holds in a window's context. */
export const matchesWhen = (
  when: MenuWhen | undefined,
  context: WindowContext | undefined,
): boolean =>
  when === undefined ||
  ((when.path === undefined || when.path === context?.path) &&
    (when.focus === undefined || when.focus === context?.focus));

const sameWhen = (left?: MenuWhen, right?: MenuWhen): boolean =>
  (left?.path ?? null) === (right?.path ?? null) &&
  (left?.focus ?? null) === (right?.focus ?? null);

export interface NativeMenusDeps {
  readonly registry: WindowRegistry;
  readonly platform: NodeJS.Platform;
  /** The generation whose skeleton applies with no focused window. */
  readonly newestGeneration: () => number | undefined;
  readonly dispatch: (
    command: string,
    origin: { windowKey: string | null },
  ) => void;
  readonly electron: {
    setApplicationMenu(menu: Menu): void;
    buildFromTemplate(template: MenuItemConstructorOptions[]): Menu;
    item(options: MenuItemConstructorOptions): MenuItem;
    setDockMenu?(menu: Menu): void;
  };
  /** A window's effective keybinding table changed. */
  readonly bindingsChanged?: (entry: WindowEntry) => void;
}

export class NativeMenus {
  readonly #deps: NativeMenusDeps;
  readonly #skeletons = new Map<number, MenuSkeleton>();
  /**
   * The skeleton set last: a generation that never set one (the core sets it
   * at `onAppReadyHook`, which a background generation does not get) shows
   * it with its own items.
   */
  #lastSkeleton: MenuSkeleton | undefined;
  readonly #items: Owned<MenuItemRequest>[] = [];
  readonly #bindings: Owned<KeybindingRequest>[] = [];
  #sequence = 0;
  readonly #sequences = new Map<string, number>();

  constructor(deps: NativeMenusDeps) {
    this.#deps = deps;
  }

  #sequenceOf(generation: number, owner: string): number {
    const key = `${generation}\u0000${owner}`;
    let sequence = this.#sequences.get(key);

    if (sequence === undefined) {
      this.#sequence += 1;
      sequence = this.#sequence;
      this.#sequences.set(key, sequence);
    }

    return sequence;
  }

  setSkeleton(generation: number, skeleton: MenuSkeleton): void {
    this.#skeletons.set(generation, skeleton);
    this.#lastSkeleton = skeleton;
    this.rebuild();
  }

  skeleton(generation: number): MenuSkeleton | undefined {
    return this.#skeletons.get(generation);
  }

  add(generation: number, item: MenuItemRequest): void {
    const owner = item.owner.bundleId;

    if (
      this.#items.some(
        (entry) =>
          entry.generation === generation &&
          entry.owner === owner &&
          entry.value.id === item.id,
      )
    ) {
      throw new ContractError(
        'registration_conflict',
        `Menu item "${item.id}" of "${owner}" is already registered.`,
        { item: item.id, owner },
      );
    }

    this.#sequenceOf(generation, owner);
    this.#items.push({ generation, owner, value: item });
    this.rebuild();
  }

  addKeybinding(generation: number, binding: KeybindingRequest): void {
    const conflict = this.#bindings.find(
      (entry) =>
        entry.generation === generation &&
        entry.value.key === binding.key &&
        sameWhen(entry.value.when, binding.when),
    );

    if (conflict !== undefined) {
      throw new ContractError(
        'registration_conflict',
        `The key "${binding.key}" is already bound to "${conflict.value.command}".`,
        {
          key: binding.key,
          command: conflict.value.command,
          owner: conflict.owner,
        },
      );
    }

    this.#bindings.push({
      generation,
      owner: binding.owner.bundleId,
      value: binding,
    });
    this.#bindingsChanged(generation);
    this.rebuild();
  }

  setContext(
    windowKey: string,
    key: 'path' | 'focus',
    value: string | null,
  ): void {
    const entry = this.#deps.registry.byKey(windowKey);

    if (entry === undefined) {
      throw new ContractError('not_found', `No window "${windowKey}" is open.`);
    }

    entry.context[key] = value;
    this.#deps.bindingsChanged?.(entry);

    if (this.#deps.registry.focused() === entry) {
      this.rebuild();
    }
  }

  /** Drops what one owner registered in a generation (it deactivated). */
  dropOwner(generation: number, owner: string): void {
    this.#drop(
      (entry) => entry.generation === generation && entry.owner === owner,
    );
  }

  /** Drops a generation's registrations; its skeleton is kept unless asked. */
  dropGeneration(
    generation: number,
    options: { skeleton?: boolean } = {},
  ): void {
    if (options.skeleton === true) {
      this.#skeletons.delete(generation);
    }

    this.#drop((entry) => entry.generation === generation);
  }

  #drop(match: (entry: Owned<unknown>) => boolean): void {
    let changed = false;

    for (const list of [this.#items, this.#bindings] as Owned<unknown>[][]) {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        if (match(list[index] as Owned<unknown>)) {
          list.splice(index, 1);
          changed = true;
        }
      }
    }

    if (changed) {
      for (const entry of this.#deps.registry.all()) {
        this.#deps.bindingsChanged?.(entry);
      }

      this.rebuild();
    }
  }

  #bindingsChanged(generation: number): void {
    for (const entry of this.#deps.registry.all()) {
      if (entry.pinnedGeneration === generation) {
        this.#deps.bindingsChanged?.(entry);
      }
    }
  }

  /** The effective table of a window: its generation's bindings that match. */
  bindingsFor(entry: WindowEntry): ShellKeybinding[] {
    const generation = entry.pinnedGeneration ?? this.#deps.newestGeneration();

    return this.#bindings
      .filter(
        (binding) =>
          binding.generation === generation &&
          matchesWhen(binding.value.when, entry.context),
      )
      .map(({ value }) => ({ key: value.key, command: value.command }));
  }

  /** Rebuilds the application menu for the focused window. */
  rebuild(): void {
    const focused = this.#deps.registry.focused();
    const generation =
      focused?.pinnedGeneration ?? this.#deps.newestGeneration();
    const skeleton =
      generation === undefined
        ? undefined
        : (this.#skeletons.get(generation) ?? this.#lastSkeleton);

    // No skeleton yet: Electron's default menu stays, as today.
    if (skeleton === undefined || generation === undefined) {
      return;
    }

    const items = this.#items
      .filter(
        (entry) =>
          entry.generation === generation &&
          matchesWhen(entry.value.when, focused?.context),
      )
      .map(
        ({ value, owner }): RegisteredItem => ({
          id: value.id,
          location: value.location,
          command: value.command,
          label: value.label,
          ...(value.when === undefined ? {} : { when: value.when }),
          ...(value.order === undefined ? {} : { order: value.order }),
          sequence: this.#sequenceOf(generation, owner),
        }),
      );
    const bindings: RegisteredBinding[] = this.#bindings
      .filter(
        (entry) =>
          entry.generation === generation &&
          matchesWhen(entry.value.when, focused?.context),
      )
      .map(({ value }) => ({ command: value.command, key: value.key }));
    const { electron } = this.#deps;
    const origin = { windowKey: focused?.key ?? null };
    const dispatch = (command: string) => this.#deps.dispatch(command, origin);
    const template = menuTemplate({
      skeleton,
      items: items.filter((item) => item.location !== 'dock'),
      bindings,
      platform: this.#deps.platform,
      dispatch,
      expand: (role) => {
        const expanded = electron.buildFromTemplate([
          { role: role as MenuItemConstructorOptions['role'] },
        ]).items[0]?.submenu;

        return expanded ?? electron.buildFromTemplate([]);
      },
      item: electron.item,
    });

    electron.setApplicationMenu(electron.buildFromTemplate(template));

    const dock = items.filter((item) => item.location === 'dock');

    if (electron.setDockMenu !== undefined && dock.length > 0) {
      electron.setDockMenu(
        electron.buildFromTemplate(
          dock.map((item) => ({
            label: item.label,
            click: () => dispatch(item.command),
          })),
        ),
      );
    }
  }
}
