// T4.2 (AC4.2): the KV conformance kit on the `sqlite` engine bundle, spawned
// by `openTestEngine` on `doric.sqlite3` in a temporary directory.

import { runKvConformance } from '../src/conformance/kv/index.js';
import { openTestEngine } from '../src/testing.js';

runKvConformance({ name: 'sqlite', open: () => openTestEngine() });
