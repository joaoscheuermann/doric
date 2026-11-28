// T4.8 (AC4.7): two instances of one bundle commit concurrently over one
// `sqlite` engine, and an instance of another bundle is `not_owner`; the
// stream cases C2 and C3 are skipped until S78.

import {
  instanceV2Cases,
  runStorageV2Conformance,
} from '../src/conformance/v2/index.js';

runStorageV2Conformance({ cases: instanceV2Cases });
