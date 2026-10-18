import { ContractError } from 'bundle/contracts';

/** Where a query page ended: the last item's index key and document ID. */
export interface CursorPosition {
  readonly key: Uint8Array;
  readonly id: string;
}

/** An opaque base64url string; only the backend that wrote it reads it back. */
export const encodeCursor = (position: CursorPosition): string =>
  Buffer.from(
    JSON.stringify({
      k: Buffer.from(position.key).toString('base64url'),
      i: position.id,
    }),
    'utf8',
  ).toString('base64url');

const base64url = /^[A-Za-z0-9_-]*$/;

const invalidCursor = (): ContractError =>
  new ContractError('invalid_input', 'The query cursor is not valid.');

/** Reads a cursor written by `encodeCursor`; anything else is `invalid_input`. */
export const decodeCursor = (cursor: string): CursorPosition => {
  if (!base64url.test(cursor)) {
    throw invalidCursor();
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { k?: unknown }).k !== 'string' ||
    typeof (parsed as { i?: unknown }).i !== 'string'
  ) {
    throw invalidCursor();
  }

  const { k, i } = parsed as { k: string; i: string };

  if (!base64url.test(k)) {
    throw invalidCursor();
  }

  return { key: new Uint8Array(Buffer.from(k, 'base64url')), id: i };
};
