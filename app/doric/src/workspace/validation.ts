import { WorkspaceError } from './api';

const maximumNameLength = 80;

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
