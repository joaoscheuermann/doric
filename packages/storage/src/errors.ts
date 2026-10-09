import { ContractError } from 'bundle/contracts';

/** An `expect` entry does not match the stored revision (0 = absent). */
export const revisionConflict = (
  key: { readonly type: string; readonly id: string },
  expected: number,
  actual: number,
): ContractError =>
  new ContractError(
    'revision_conflict',
    `Document ${key.type} ${key.id} is at revision ${actual}, not ${expected}.`,
    { type: key.type, id: key.id, expected, actual },
  );

/** An append's `expectedSequence` is not the stream's `lastSequence`. */
export const sequenceConflict = (
  stream: string,
  expected: number,
  actual: number,
): ContractError =>
  new ContractError(
    'sequence_conflict',
    `Stream ${stream} is at sequence ${actual}, not ${expected}.`,
    { stream, expected, actual },
  );

/** A put gives a unique index a key another document already holds. */
export const uniqueConflict = (type: string, index: string): ContractError =>
  new ContractError(
    'unique_conflict',
    `Another ${type} document already holds this key of the unique index "${index}".`,
    { type, index },
  );

/** The batch, a document or an appended event goes over a backend limit. */
export const limitExceeded = (
  what: 'batch' | 'document' | 'append',
  limit: number,
): ContractError =>
  new ContractError(
    'limit_exceeded',
    what === 'batch'
      ? `The commit batch holds more than ${limit} items.`
      : what === 'document'
        ? `A document is larger than ${limit} bytes.`
        : `An appended event is larger than ${limit} bytes.`,
    { what, limit },
  );
