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
  type Services,
} from 'bundle/contracts';

type Level = LogRecord['level'];

/** The trace ID of a W3C traceparent (`00-<trace>-<span>-<flags>`). */
const traceIdOf = (call: Call): string | undefined =>
  call.trace.traceparent.split('-')[1];

const write = (
  level: Level,
  message: string,
  fields: Readonly<Record<string, unknown>> | undefined,
  call: Call,
  services: Services,
): void => {
  try {
    const { environment } = services.use(DoricBundleV1).describe(call);
    const traceId = traceIdOf(call);
    const record: LogRecord = {
      level,
      message,
      ...(fields === undefined ? {} : { fields }),
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

const level = (name: Level) =>
  defineMethod({
    input: logMethods[name].input,
    output: logMethods[name].output,
    execute: ([message, fields], call, services) => {
      write(name, message, fields, call, services);
    },
  });

/**
 * The core's `log/v1`: each record names the calling bundle, its version and
 * generation, the call's scope and trace, and the environment, and reaches
 * the host's log files through `doric.log/v1`.
 */
export const createLog = () =>
  defineService(LogV1, {
    debug: level('debug'),
    info: level('info'),
    warn: level('warn'),
    error: level('error'),
  });
