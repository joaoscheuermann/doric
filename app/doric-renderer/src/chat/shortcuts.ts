export type Shortcut = {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
};

export const shouldSubmit = (event: Shortcut, platform: string): boolean => {
  if (event.key !== 'Enter' || event.altKey || event.shiftKey) return false;
  if (platform.startsWith('Mac')) return event.metaKey && !event.ctrlKey;
  if (platform.startsWith('Win')) return event.ctrlKey && !event.metaKey;
  return false;
};
