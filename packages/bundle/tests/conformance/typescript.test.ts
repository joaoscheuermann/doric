// The protocol conformance suite against the TypeScript SDK's fixture (spec
// `docs/designs/grpc-processes.md`, section 10, "Protocol conformance across
// SDKs"; T2.14). Run by the `conformance` target, not by `test`.

import { fileURLToPath } from 'node:url';

import { runConformance } from '../../src/testing/index.js';

const fixture = fileURLToPath(
  new URL('../fixtures/conformance/main.js', import.meta.url),
);

await runConformance({
  command: { command: process.execPath, args: [fixture] },
});
