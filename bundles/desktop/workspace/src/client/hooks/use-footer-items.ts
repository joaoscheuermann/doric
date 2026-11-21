// The drawable entries of `workspace.dashboard.footer` (spec §8): the region's
// data items whose props pass `footerItemProps`. Each malformed item is
// reported once per id until the activation's cleanup forgets the reports.

import type { Regions } from 'bundle/contracts';
import { useRegionItems } from 'desktop/ui/element-host';
import { useEffect, useMemo } from 'react';

import {
  type DashboardFooterItemProps,
  WORKSPACE_DASHBOARD_FOOTER,
} from '../../contracts/index.js';
import { footerItemProps } from '../domain/footer-items.js';

/** One drawable entry of the dashboard footer. */
export interface FooterEntry {
  readonly id: string;
  readonly tag: string;
  readonly props: DashboardFooterItemProps;
}

/** The ids of the malformed items already reported. */
const reported = new Set<string>();

/** Forgets the reported ids; called by the activation's cleanup. */
export const resetFooterReports = (): void => {
  reported.clear();
};

/**
 * The drawable entries of `workspace.dashboard.footer`, in region order.
 * Reports each malformed item once per id: `console.error('Doric: …')`.
 */
export const useFooterItems = (regions: Regions): readonly FooterEntry[] => {
  const items = useRegionItems(regions, WORKSPACE_DASHBOARD_FOOTER);
  const checked = useMemo(
    () => items.map((item) => ({ item, props: footerItemProps(item.props) })),
    [items],
  );

  useEffect(() => {
    for (const { item, props } of checked) {
      if (props !== undefined || reported.has(item.id)) continue;
      reported.add(item.id);
      console.error(
        `Doric: the dashboard footer item "${item.id}" of ${item.owner} has malformed props and is not drawn:`,
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
