# Agent Instructions

Applies to `agents/*`. Follow the root `GROUNDING.md` and `AGENTS.md` first;
this file only adds local conventions for agent packages.

## Keep It Readable

- Prevent deep nesting. Add folders only when they make the code easier to
  scan.
- Keep most executor behavior in `executor.ts`.
- Write minimal, streamlined code.
- Prefer direct imperative control flow when it is more legible than a
  functional pipeline.
- Do not over-decouple. If logic is used once and reads clearly inline, leave
  it inline.
- Extract a helper only when it removes real duplication or names a meaningful
  concern.
- Reuse the host's shared helpers rather than writing a second version:
  `redactSecrets` (`credentials/redact.ts`), `createMutationQueue`
  (`workspace/runtime.ts`) and `teardownSocket` (`workspace/socket-teardown.ts`).

## Default Agent Pattern

Use `agents/doric/src/index.ts` as the default pattern for new agent entrypoints.
The entrypoint is the composition root: it should create the app, read runtime
host/port config, instantiate stores, build the Agent Card, create the executor
with explicit dependencies, register protocol routes, and start listening.

Keep agent behavior out of `index.ts`. Move durable behavior into small
factories or modules with semantic names:

- `createAgentCard(...)` owns static Agent Card shape and protocol metadata.
- `createExecutor(...)` owns request execution, context/session behavior, and
  agent-side effects.
- Message factories own protocol message shapes.
- Constants modules own shared literal values used by source and tests.

Inject required infrastructure at the factory boundary instead of hiding
defaults inside executor code. If an executor needs sessions, Docker, sandbox
creation, providers, tools, or stores, make those dependencies explicit in the
factory input and let `index.ts` provide the production instances.

Test the extracted behavior directly. Prefer focused tests with fakes for
executor behavior, card shape, message factories, and constants. Start an HTTP
server in tests only when route wiring or startup behavior is the behavior under
test.

When developing an agent, use this order:

1. Wire the smallest working entrypoint with the real protocol adapter.
2. Extract stable protocol metadata into card/message/constant modules.
3. Move request behavior into an executor factory with explicit dependencies.
4. Add tests against the extracted factories and fakes.
5. Return to `index.ts` and keep only production wiring and startup there.

## File Shape

- `index.ts` starts the server.
- The server file should stay minimal: wire config, routes, executor, and
  startup only.
- `executor.ts` contains only the main executor logic.
- A2A Agent Card definitions live in `card.ts`.
- Message object factories live under `lib/messages/`.
- Constant variables live under `lib/constants/`.
- Supporting logic lives in `lib/utils/<utility>.ts`.
