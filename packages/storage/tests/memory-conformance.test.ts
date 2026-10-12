import { runStorageConformance } from '../src/conformance/index.js';
import { memoryHarness } from './support/memory-harness.js';

// Stage-3 evidence on the reference backend: the whole conformance kit
// against the in-memory storage.backend/v1.
runStorageConformance(memoryHarness());
