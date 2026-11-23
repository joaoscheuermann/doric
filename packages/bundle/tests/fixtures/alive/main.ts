// A host part's `main.ts` that serves nothing and activates at once: the
// smallest program of `runBundle` (spec `docs/designs/grpc-processes.md`,
// section 10, A61). `tests/platform/sdk-lifecycle.test.ts` spawns its compiled
// form with the spawn environment and checks the codes the process exits with.

import { runBundle } from '../../../src/index.js';

runBundle({
  activate: () => {},
});
