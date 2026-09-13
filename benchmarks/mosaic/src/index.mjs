import { fileURLToPath } from 'node:url';

import { runHost } from 'benchmark-harness';

await runHost('mosaic', fileURLToPath(new URL('../', import.meta.url)));
