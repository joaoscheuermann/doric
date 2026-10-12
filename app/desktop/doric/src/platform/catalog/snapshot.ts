// `userData/doric/catalog-snapshot.json`: the last distribution that
// activated, for the disconnected mode ("Open last known composition").

import {
  type DistributionCatalog,
  distributionCatalogSchema,
} from 'bundle/runtime';

import { readJson, writeJsonAtomic } from '../state';

export const saveCatalogSnapshot = (
  path: string,
  catalog: DistributionCatalog,
): Promise<void> => writeJsonAtomic(path, catalog);

export const loadCatalogSnapshot = (
  path: string,
): Promise<DistributionCatalog | undefined> =>
  readJson(path, distributionCatalogSchema);
