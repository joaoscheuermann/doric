import { fileURLToPath } from 'node:url';

import { runHost } from 'benchmark-harness';

await runHost('direct', fileURLToPath(new URL('../', import.meta.url)));
