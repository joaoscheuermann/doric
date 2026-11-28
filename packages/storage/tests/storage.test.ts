// T4.3, T4.9, T4.23 (AC4.2, AC4.8, AC4.23): the `storage/v2` conformance
// cases of documents, queries, streams, blobs, health, snapshot and cursor,
// commit failure and limits, through the client, over a `sqlite` engine
// spawned on a file in a temporary directory.

import {
  runStorageV2Conformance,
  storageV2Cases,
} from '../src/conformance/v2/index.js';

runStorageV2Conformance({ cases: storageV2Cases });
