// T4.2 (AC4.2): the heavy cases of the KV conformance kit, each streaming a
// commit of 200,001 items, on their own `sqlite` engine. `storage:test`
// leaves them out; `storage:test-heavy` runs only this file.

import { runKvConformance } from '../src/conformance/kv/index.js';
import { openTestEngine } from '../src/testing.js';

runKvConformance(
  { name: 'sqlite (heavy)', open: () => openTestEngine() },
  { heavy: true },
);
