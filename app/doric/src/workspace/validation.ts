import { WorkspaceError } from './api';

const maximumNameLength = 80;

/** The palette the host accepts; a client only ever names one of these. */
const projectColors = [
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const;

export const senderIsAllowed = (
  senderUrl: string | undefined,
  rendererUrl: string,
): boolean => senderUrl === rendererUrl;

export const name = (value: unknown): string => {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new WorkspaceError('Enter a valid name before continuing.');
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || Array.from(trimmed).length > maximumNameLength) {
    throw new WorkspaceError('Enter a name between 1 and 80 characters.');
  }

  return trimmed;
};

export const identifier = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.includes('\0')
  ) {
    throw new WorkspaceError('The item identifier is invalid.');
  }

  return value;
};

/** A palette color, or undefined when the color is being cleared. */
export const projectColor = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'string' ||
    !(projectColors as readonly string[]).includes(value)
  ) {
    throw new WorkspaceError('Choose a color from the palette.');
  }
  return value;
};

export const prompt = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkspaceError('Enter a prompt before continuing.');
  }
  return value;
};

export const sequence = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceError('The event cursor is invalid.');
  }
  return value;
};
