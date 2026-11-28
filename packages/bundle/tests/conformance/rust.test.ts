// The protocol conformance suite against the Rust SDK's fixture (spec
// `docs/designs/grpc-processes.md`, section 10, "Protocol conformance across
// SDKs"; T4.5, AC4.3, AC4.6): the example `conformance` of
// `packages/bundle-rs`, built by `doric-bundle:compile-example`. Run by the
// `conformance` target, not by `test`.

import { fileURLToPath } from 'node:url';

import { runConformance } from '../../src/testing/index.js';

// From `packages/bundle/dist-tests/tests/conformance/` to the repository root.
const fixture = fileURLToPath(
  new URL(
    '../../../../../dist/target/doric-bundle/debug/examples/conformance',
    import.meta.url,
  ),
);

await runConformance({ command: { command: fixture, args: [] } });
