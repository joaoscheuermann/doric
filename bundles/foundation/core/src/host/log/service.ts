// The core's `log/v1` over the router: each record of a bundle, stamped
// with its caller and redacted, written to `doric.log/v1`.

import type { JsonObject } from '@bufbuild/protobuf';
import type { ServiceImpl } from '@connectrpc/connect';
import { type Call, ContractError, callOf } from 'bundle/contracts';
import type {
  LogRecord,
  LogService,
} from 'bundle/contracts/gen/doric/log/v1/log_pb.js';

import { redactLeaves, redactSecrets } from '../../shared/redact.js';
import type { CoreBinding } from '../binding.js';

/**
 * `log/v1` as `createCoreServices` serves it.
 *
 * Each record is written with `bind().writeLog` as `doric.log/v1.Write{
 * level, message, fields?, bundleId, version, generation,
 * environment: 'host', scope, traceId? }`:
 * - `bundleId`, `version` and `generation` are the router-stamped caller's.
 * - `scope` is `call.scope` (empty when absent).
 * - `traceId` is the second field of `call.trace.traceparent`.
 * - The message and every string leaf of `fields` are first redacted with
 *   `redactions(call)` (`[REDACTED]`, `redactSecrets` / `redactLeaves`).
 *
 * - `Write` answers once the record is written.
 * - `WriteBatch` writes the records in stream order, one at a time, and
 *   answers when all are written.
 *
 * Failure: a rejection of `redactions` or `writeLog` fails the RPC with its
 * Doric code (records before it in a batch stay written), so the SDK's
 * queue writes the batch to stdout (A7). A record's content never fails a
 * write once protovalidate accepted it.
 */
export const createLogService = (
  bind: () => CoreBinding,
  redactions: (call: Call) => Promise<readonly string[]>,
): { readonly implementation: ServiceImpl<typeof LogService> } => {
  /** Writes one record of `call`'s caller to `doric.log/v1`. */
  const write = async (
    record: LogRecord | undefined,
    call: Call,
  ): Promise<void> => {
    const binding = bind();

    if (record === undefined) {
      throw new ContractError('invalid_input', 'A log record is required.');
    }

    const secrets = await redactions(call);
    const traceId = call.trace.traceparent.split('-')[1];

    await binding.writeLog(
      {
        level: record.level,
        message: redactSecrets(record.message, secrets),
        ...(record.fields === undefined
          ? {}
          : { fields: redactLeaves(record.fields, secrets) as JsonObject }),
        bundleId: call.caller.bundleId,
        version: call.caller.version,
        generation: call.caller.generation,
        environment: 'host',
        scope: { ...call.scope },
        ...(traceId === undefined ? {} : { traceId }),
      },
      call,
    );
  };

  return {
    implementation: {
      write: async ({ record }, context) => {
        await write(record, callOf(context));

        return {};
      },
      writeBatch: async (requests, context) => {
        const call = callOf(context);

        bind();

        for await (const { record } of requests) {
          await write(record, call);
        }

        return {};
      },
    },
  };
};
