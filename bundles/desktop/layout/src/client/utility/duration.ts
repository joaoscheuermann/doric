/** A compact elapsed time; hours appear only when needed. */
export const duration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const clock = `${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  return minutes < 60 ? clock : `${Math.floor(minutes / 60)}:${clock}`;
};
