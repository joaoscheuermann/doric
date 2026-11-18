// The drawable entries of `account.menu` (spec §7–§8): the region's data
// items whose props pass `menuItemProps`. Each malformed item is reported
// once per id until the activation's cleanup forgets the reports.

import type { Regions } from 'bundle/contracts';
import { useRegionItems } from 'desktop/ui/element-host';
import { useEffect, useMemo } from 'react';

import {
  ACCOUNT_MENU,
  type AccountMenuItemProps,
} from '../../contracts/index.js';
import { menuItemProps } from '../domain/menu-items.js';

/** One drawable entry of the account menu. */
export interface MenuEntry {
  readonly id: string;
  readonly tag: string;
  readonly props: AccountMenuItemProps;
}

/** The ids of the malformed items already reported. */
const reported = new Set<string>();

/** Forgets the reported ids; called by the activation's cleanup. */
export const resetMenuReports = (): void => {
  reported.clear();
};

/**
 * The drawable entries of `account.menu`, in region order. Reports each
 * malformed item once per id: `console.error('Doric: …')`.
 */
export const useMenuItems = (regions: Regions): readonly MenuEntry[] => {
  const items = useRegionItems(regions, ACCOUNT_MENU);
  const checked = useMemo(
    () => items.map((item) => ({ item, props: menuItemProps(item.props) })),
    [items],
  );

  useEffect(() => {
    for (const { item, props } of checked) {
      if (props !== undefined || reported.has(item.id)) continue;
      reported.add(item.id);
      console.error(
        `Doric: the account menu item "${item.id}" of ${item.owner} has malformed props and is not drawn:`,
        item.props,
      );
    }
  }, [checked]);

  return useMemo(
    () =>
      checked.flatMap(({ item, props }) =>
        props === undefined ? [] : [{ id: item.id, tag: item.tag, props }],
      ),
    [checked],
  );
};
