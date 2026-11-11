/** A compact elapsed time; hours appear only when needed. */
export const duration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const clock = `${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  return minutes < 60 ? clock : `${Math.floor(minutes / 60)}:${clock}`;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The elapsed badge text, at most 8 characters (D6):
 * - under 100 h: exactly `duration(milliseconds)`, so `mm:ss` under 1 h and
 *   `h:mm:ss` with unpadded hours from 1 h (`99:59:59` at most);
 * - from 100 h to under 100 days: `{d}d {h}h`, the whole days and the
 *   remaining whole hours, unpadded (`4d 4h`, `99d 23h`);
 * - from 100 days: `99d+`.
 * A negative time reads `00:00`, as in `duration`. Give it a finite number;
 * the caller checks that the start parses.
 */
export const elapsedBadge = (milliseconds: number): string => {
  if (milliseconds < 100 * HOUR) return duration(milliseconds);
  if (milliseconds >= 100 * DAY) return '99d+';
  const hours = Math.floor(milliseconds / HOUR);
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};
