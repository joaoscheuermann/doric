/**
 * A turn's time, as the conversation shows it: recent turns read as elapsed
 * time, and anything older than a day as a date and a clock time. Stated in
 * terms of its arguments so it can be checked without a clock.
 */
export const relativeTime = (iso: string, now: Date = new Date()): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';

  const seconds = Math.floor((now.getTime() - at.getTime()) / 1000);
  if (seconds < 60) return 'now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;

  return at.toLocaleString(undefined, {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
  });
};
