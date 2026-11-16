import { DoricCatalogV1 } from 'bundle/contracts';
import { useMemo } from 'react';

import {
  type QuarantineNotice,
  quarantineNotice,
} from '../domain/bundle-health.js';
import { layoutServices } from '../services/layout-services.js';

/** The notice of the window's catalog, or none when it cannot be read. */
const readNotice = (): QuarantineNotice | undefined => {
  try {
    return quarantineNotice(layoutServices().use(DoricCatalogV1).get());
  } catch {
    // The layout is not active, or the host does not provide the catalog:
    // there is nothing to report.
    return undefined;
  }
};

/**
 * The window's quarantine notice (§7.2): `quarantineNotice` of the snapshot
 * `doric.catalog/v1` answers through the layout's activation services
 * (`layoutServices().use(DoricCatalogV1).get()`).
 *
 * The catalog is read once per mount; a later change to the catalog shows
 * on the next mount (a frame switch remounts the sidebars). Answers
 * `undefined` when no bundle is quarantined, and also when the read throws
 * (the layout is not active, or the host does not provide the contract):
 * the hook itself never throws.
 */
export const useQuarantineNotice = (): QuarantineNotice | undefined =>
  useMemo(readNotice, []);
