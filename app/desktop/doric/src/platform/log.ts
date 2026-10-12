// The desktop platform's log: one JSON line per record on the console. Main
// keeps no log files (stage 8); the host writes its own.

export type PlatformLogLevel = 'info' | 'warn' | 'error';

export interface PlatformLog {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface LogConsole {
  log(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

const serialize = (value: unknown): unknown =>
  value instanceof Error ? { name: value.name, message: value.message } : value;

/** One JSON line: `{ level, time, msg, ...fields }`. */
export const formatLogLine = (
  level: PlatformLogLevel,
  fields: Readonly<Record<string, unknown>>,
  message: string,
  now: () => Date = () => new Date(),
): string =>
  JSON.stringify(
    {
      level,
      time: now().toISOString(),
      msg: message,
      ...fields,
    },
    (_key, value: unknown) => serialize(value),
  );

export const createPlatformLog = (
  output: LogConsole = console,
  now?: () => Date,
): PlatformLog => ({
  info: (fields, message) =>
    output.log(formatLogLine('info', fields, message, now)),
  warn: (fields, message) =>
    output.warn(formatLogLine('warn', fields, message, now)),
  error: (fields, message) =>
    output.error(formatLogLine('error', fields, message, now)),
});

/** A log that drops everything (tests). */
export const silentLog: PlatformLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
