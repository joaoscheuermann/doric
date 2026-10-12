import { minimalUiCore } from 'bundle/testing';

import type { ClientBundle } from './fixtures.js';

/** The minimal test core (`bundle/testing`) as a client bundle of the window catalog. */
export const mincoreBundle = (id = 'mincore'): ClientBundle => {
  const core = minimalUiCore({ id });

  return {
    id,
    provides: core.manifest.provides,
    contracts: core.descriptor.contracts.map((contract) => ({
      id: contract.id,
      version: contract.version,
    })),
    activate: core.client.activate,
  };
};
