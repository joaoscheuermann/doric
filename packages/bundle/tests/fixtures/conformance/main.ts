// The TypeScript SDK's fixture of the protocol conformance suite (spec
// `docs/designs/grpc-processes.md`, section 10, "Protocol conformance across
// SDKs"; T2.14): a host part that serves
// `doric.conformance.v1.ConformanceService` as its `.proto` comments say.
// `tests/conformance/typescript.test.ts` runs `runConformance` against its
// compiled form. `DORIC_CONFORMANCE_ACTIVATE=fail` makes its activation fail.

import type { MessageInitShape } from '@bufbuild/protobuf';

import { callOf, ContractError, deadlineOf } from '../../../src/contracts/index.js';
import {
  ConformanceService,
  type ObservedResponseSchema,
} from '../../../src/contracts/gen/doric/conformance/v1/conformance_pb.js';
import { runBundle } from '../../../src/index.js';

type Observation = MessageInitShape<typeof ObservedResponseSchema>;

/** What each `Wait` call saw, by its key; a later `Wait` replaces it. */
const observations = new Map<string, Observation>();

const activationFails = process.env.DORIC_CONFORMANCE_ACTIVATE === 'fail';

runBundle({
  services: [
    [
      ConformanceService,
      {
        echo: (request) => ({
          text: request.text,
          padding: new Uint8Array(request.padBytes),
        }),
        count: async function* (request) {
          for (let index = 0; index < request.n; index += 1) {
            yield { index };
          }
        },
        sum: async (requests) => {
          let total = 0;
          let count = 0;

          for await (const request of requests) {
            total += request.value;
            count += 1;
          }

          return { total, count };
        },
        fail: (request) => {
          throw new ContractError(
            request.code,
            request.message,
            request.details,
          );
        },
        wait: async (request, context) => {
          const call = callOf(context);
          const observation: Observation = {
            found: true,
            callerBundleId: call.caller.bundleId,
            callerVersion: call.caller.version,
            callerGeneration: call.caller.generation,
            scope: { ...call.scope },
            traceparent: call.trace.traceparent,
            deadlineUnixMs: deadlineOf(call),
            cancelled: false,
            answered: false,
          };

          observations.set(request.key, observation);
          await new Promise<void>((resolve, reject) => {
            const cancelled = (): void => {
              clearTimeout(timer);
              observation.cancelled = true;
              reject(call.signal.reason);
            };
            const timer =
              request.holdMs === 0
                ? undefined
                : setTimeout(() => {
                    call.signal.removeEventListener('abort', cancelled);
                    observation.answered = true;
                    resolve();
                  }, request.holdMs);

            if (call.signal.aborted) {
              cancelled();

              return;
            }

            call.signal.addEventListener('abort', cancelled, { once: true });
          });

          return { key: request.key };
        },
        observed: (request) =>
          observations.get(request.key) ?? { found: false },
        freeze: () => {
          process.kill(process.pid, 'SIGSTOP');

          return {};
        },
      },
    ],
  ],
  activate: () => {
    if (activationFails) {
      throw new ContractError(
        'activation_failed',
        'The fixture fails its activation (DORIC_CONFORMANCE_ACTIVATE=fail).',
      );
    }
  },
});
