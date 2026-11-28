// T4.24 (AC4.23), the TypeScript part: `Register`'s refusals, empty and
// field-less declarations, a registration that writes nothing, the backfill
// of a new index, and the generation rule, each generation case on an engine
// of its own.

import {
  registrationV2Cases,
  runStorageV2Conformance,
} from '../src/conformance/v2/index.js';

runStorageV2Conformance({ cases: registrationV2Cases });
