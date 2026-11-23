// The protocol conformance suite (spec `docs/designs/grpc-processes.md`,
// section 10, "Protocol conformance across SDKs"; A28, T2.14, T4.5): one
// suite, run against each SDK's fixture, that checks the SDK speaks the
// control protocol of `doric/platform/v1/control.proto`. The suite plays the
// router; the fixture serves `doric.conformance.v1.ConformanceService`.

import type { SpawnCommand } from '../../platform/supervisor/spawn.js';

/** What `runConformance` runs the suite against. */
export interface ConformanceOptions {
  /**
   * The fixture's executable: the command and arguments that start one
   * process of a bundle serving `doric.conformance.v1.ConformanceService`
   * on an SDK, as the supervisor would spawn it (A64), e.g.
   * `{ command: process.execPath, args: ['<fixture>/main.js'] }`.
   */
  readonly command: SpawnCommand;
  /**
   * The base environment of every fixture process, default `process.env`.
   * The suite adds the variables of section 7, "Spawn"
   * (`instanceEnvironment`), replacing any of the same name, and, for the
   * activation-failure case only, `DORIC_CONFORMANCE_ACTIVATE=fail`.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Registers the protocol conformance cases as `node:test` tests, under one
 * `describe` named after `options.command`. Each case serves
 * `BundleHostService/Connect` on a loopback port of its own, starts a fresh
 * fixture process with `options.command`, drives the control frames and
 * checks what the SDK answers:
 *
 * - Hello with the token and the instance; a refused Hello, after which the
 *   process exits with code 70;
 * - the end of the control stream after `Accepted`, and a Hello never
 *   answered, each followed by exit code 70, the second within the Hello
 *   timeout (10 s) and one second;
 * - one `HealthReply` with the nonce per `HealthCheck`, and no reply after
 *   `Freeze` (the case the router quarantines);
 * - activation success, and failure under `DORIC_CONFORMANCE_ACTIVATE=fail`;
 * - `Echo`, `Count` and `Sum` with 1,000 messages each while the suite grants
 *   credit slowly, with no message beyond credit;
 * - `Fail` with each family of the error table: its gRPC code, message,
 *   `ErrorInfo` reason and details;
 * - cancellation and deadline seen by the `Wait` handler (read back with
 *   `Observed`), each followed by `CallEnd` `CANCELLED`;
 * - `GenerationChanged { draining }` acknowledged while a `Wait` in flight
 *   finishes;
 * - `Stop` answered, and exit code 0 within the stop deadline;
 * - an unregistered method answered `UNIMPLEMENTED`;
 * - an `Echo` response over 4 MiB ended with `RESOURCE_EXHAUSTED`, reason
 *   `limit_exceeded`.
 *
 * Call it once per fixture, from a test file's top level. It resolves once
 * the cases are registered, before any runs; a case fails as a `node:test`
 * failure and never rejects this promise. Every process a case starts is
 * killed (`SIGKILL`, which also ends a frozen one) and every port closed by
 * the end of that case, whether it passed or not.
 *
 * @throws Rejects only when the cases cannot be registered, e.g. when called
 *   outside the `node:test` runner.
 */
export const runConformance = async (
  options: ConformanceOptions,
): Promise<void> => {
  // Loaded here, not at the top: many bundles import `bundle/testing`.
  const { registerConformance } = await import('./suite.js');

  registerConformance(options);
};
