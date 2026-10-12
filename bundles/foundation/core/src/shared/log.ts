import {
  type Call,
  DoricBundleV1,
  DoricDiagnosticsV1,
  DoricLogV1,
  defineMethod,
  defineService,
  type LogRecord,
  LogV1,
  logMethods,
  SecretsV1,
  type Services,
} from 'bundle/contracts';

import { redactLeaves, redactSecrets } from './redact.js';

type Level = LogRecord['level'];

/** The trace ID of a W3C traceparent (`00-<trace>-<span>-<flags>`). */
const traceIdOf = (call: Call): string | undefined =>
  call.trace.traceparent.split('-')[1];

/**
 * The secrets a record must not show. Before the credentials are loaded (or
 * without a secrets/v1 provider) nothing can have been resolved, so the
 * record is written as it is.
 */
const redactionsOf = (services: Services): readonly string[] => {
  try {
    return services.use(SecretsV1).view().redactions();
  } catch {
    return [];
  }
};

export interface LogOptions {
  /**
   * Whether records are redacted with `secrets/v1.view().redactions()`
   * (default true). The client part passes false: a window never holds
   * resolved secrets, and `secrets/v1` there is a host contract.
   */
  readonly redact?: boolean;
}

const write = (
  level: Level,
  message: string,
  fields: Readonly<Record<string, unknown>> | undefined,
  call: Call,
  services: Services,
  redact: boolean,
): void => {
  try {
    const { environment } = services.use(DoricBundleV1).describe(call);
    const traceId = traceIdOf(call);
    const secrets = redact ? redactionsOf(services) : [];
    const record: LogRecord = {
      level,
      message: redactSecrets(message, secrets),
      ...(fields === undefined
        ? {}
        : {
            fields: redactLeaves(fields, secrets) as Readonly<
              Record<string, unknown>
            >,
          }),
      bundleId: call.caller.bundleId,
      version: call.caller.version,
      generation: call.caller.generation,
      environment,
      ...(call.scope === undefined ? {} : { scope: call.scope }),
      ...(traceId === undefined ? {} : { traceId }),
    };

    services.use(DoricLogV1).write(record, call);
  } catch (error) {
    // A log level never throws; the failure is recorded where it can be.
    try {
      services.use(DoricDiagnosticsV1).report({
        bundleId: call.caller.bundleId,
        kind: 'log_write_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // Nothing else can be done for a log record that cannot be written.
    }
  }
};

const level = (name: Level, redact: boolean) =>
  defineMethod({
    input: logMethods[name].input,
    output: logMethods[name].output,
    execute: ([message, fields], call, services) => {
      write(name, message, fields, call, services, redact);
    },
  });

/**
 * The core's `log/v1`: each record names the calling bundle, its version and
 * generation, the call's scope and trace, and the environment, and reaches
 * the host's log files through `doric.log/v1`. Every secret of
 * `secrets/v1.view().redactions()` is replaced by `[REDACTED]` in the message
 * and in the string leaves of the fields first.
 */
export const createLog = (options: LogOptions = {}) => {
  const redact = options.redact ?? true;

  return defineService(LogV1, {
    debug: level('debug', redact),
    info: level('info', redact),
    warn: level('warn', redact),
    error: level('error', redact),
  });
};
