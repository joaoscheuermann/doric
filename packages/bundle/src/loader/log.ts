import type { LogRecord } from '../contracts/platform.js';

export type { PlatformLog } from '../runtime/activation.js';

/** Where `doric.log/v1` records are written (the host's log files). */
export interface LogSink {
  write(record: LogRecord): void;
}
