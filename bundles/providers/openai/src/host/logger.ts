import type { Log, LogFields } from 'bundle/contracts';
import pino, { type Logger } from 'pino';

const levelOf = (value: unknown): keyof Log => {
  const level = typeof value === 'number' ? value : 30;

  if (level >= 50) return 'error';
  if (level >= 40) return 'warn';
  if (level >= 30) return 'info';

  return 'debug';
};

/**
 * A pino logger (what the llms providers take) whose records go to `log/v1`. It
 * keeps the kernel logger's `debug` level; pino's own bookkeeping fields
 * (`level`, `time`, `pid`, `hostname`, `msg`) become the log/v1 level and
 * message, and every other field (child bindings included) is passed on.
 */
export const logV1Logger = (log: Log): Logger =>
  pino(
    { level: 'debug' },
    {
      write(line: string) {
        try {
          const {
            level,
            time: _time,
            pid: _pid,
            hostname: _hostname,
            msg,
            ...fields
          } = JSON.parse(line) as Record<string, unknown>;

          log[levelOf(level)](
            typeof msg === 'string' ? msg : '',
            fields as LogFields,
          );
        } catch {
          // A log record never fails the caller.
        }
      },
    },
  );
