import { runStorageConformance } from '../src/conformance/index.js';
import { routerHarness } from './support/router-harness.js';

// T3.9 on the reference backend: the whole conformance kit against the
// in-memory storage.backend/v1 served by `serveStorageBackend` through the
// test router and called by `storageBackendClient`.
runStorageConformance(routerHarness());
