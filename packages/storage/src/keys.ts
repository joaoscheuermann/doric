import { ContractError, type StorageQuery } from 'bundle/contracts';

/** One indexed value: what an index field may hold after extraction. */
export type IndexScalar = string | number | boolean | null;

// Tag bytes. Their order is the cross-type order of every backend:
// null < false < true < numbers < strings.
const nullTag = 0x01;
const falseTag = 0x02;
const trueTag = 0x03;
const numberTag = 0x04;
const stringTag = 0x05;

/** Greater than every tag byte and every byte an encoded value starts with. */
const top = 0xff;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Under the `u` flag, `\p{Cs}` matches only surrogates without a partner. */
const loneSurrogate = /\p{Cs}/u;

const invalidValue = (message: string): ContractError =>
  new ContractError('invalid_index_value', message);

const encodeNumber = (value: number, out: number[]): void => {
  if (!Number.isFinite(value)) {
    throw invalidValue(`An indexed number must be finite, not ${value}.`);
  }

  const bytes = new Uint8Array(8);

  // -0 and 0 are the same JSON number, so they get the same key.
  new DataView(bytes.buffer).setFloat64(0, value === 0 ? 0 : value);

  if (((bytes[0] as number) & 0x80) !== 0) {
    // Negative: flip every bit, so a larger magnitude sorts first.
    for (let index = 0; index < 8; index += 1) {
      bytes[index] = ~(bytes[index] as number) & 0xff;
    }
  } else {
    // Positive: flip the sign bit, so every positive sorts after every negative.
    bytes[0] = (bytes[0] as number) | 0x80;
  }

  out.push(numberTag, ...bytes);
};

const encodeString = (value: string, out: number[]): void => {
  if (loneSurrogate.test(value)) {
    throw invalidValue(
      'An indexed string must be well-formed Unicode (it holds a lone surrogate).',
    );
  }

  out.push(stringTag);

  for (const byte of encoder.encode(value)) {
    // 0x00 is escaped so the terminator stays unambiguous and order holds.
    if (byte === 0x00) {
      out.push(0x00, top);
    } else {
      out.push(byte);
    }
  }

  out.push(0x00, 0x01);
};

const encodeScalar = (value: IndexScalar, out: number[]): void => {
  if (value === null) {
    out.push(nullTag);
  } else if (value === false) {
    out.push(falseTag);
  } else if (value === true) {
    out.push(trueTag);
  } else if (typeof value === 'number') {
    encodeNumber(value, out);
  } else if (typeof value === 'string') {
    encodeString(value, out);
  } else {
    throw invalidValue(
      `An indexed value must be a string, number, boolean or null, not ${typeof value}.`,
    );
  }
};

/**
 * Encodes index values so that comparing the bytes compares the tuples: the
 * cross-type order is `null < false < true < numbers < strings`, numbers
 * compare numerically and strings compare bytewise in UTF-8. Tag bytes: null
 * 0x01, false 0x02, true 0x03, number 0x04 + 8-byte order-preserving IEEE-754,
 * string 0x05 + UTF-8 with 0x00 escaped as 0x00 0xFF, terminated by 0x00 0x01.
 * Each tuple's encoding is a prefix of every longer tuple that starts with it.
 */
export const encodeIndexKey = (values: readonly IndexScalar[]): Uint8Array => {
  const out: number[] = [];

  for (const value of values) {
    encodeScalar(value, out);
  }

  return Uint8Array.from(out);
};

const malformedKey = (): ContractError =>
  new ContractError('invalid_input', 'Malformed index key.');

/** The inverse of `encodeIndexKey`; a byte string it never produces is `invalid_input`. */
export const decodeIndexKey = (key: Uint8Array): IndexScalar[] => {
  const values: IndexScalar[] = [];
  let index = 0;

  while (index < key.length) {
    const tag = key[index] as number;

    index += 1;

    if (tag === nullTag) {
      values.push(null);
    } else if (tag === falseTag) {
      values.push(false);
    } else if (tag === trueTag) {
      values.push(true);
    } else if (tag === numberTag) {
      if (index + 8 > key.length) {
        throw malformedKey();
      }

      const bytes = key.slice(index, index + 8);

      if (((bytes[0] as number) & 0x80) !== 0) {
        bytes[0] = (bytes[0] as number) & 0x7f;
      } else {
        for (let position = 0; position < 8; position += 1) {
          bytes[position] = ~(bytes[position] as number) & 0xff;
        }
      }

      values.push(new DataView(bytes.buffer).getFloat64(0));
      index += 8;
    } else if (tag === stringTag) {
      const text: number[] = [];

      for (;;) {
        if (index >= key.length) {
          throw malformedKey();
        }

        const byte = key[index] as number;

        if (byte !== 0x00) {
          text.push(byte);
          index += 1;
          continue;
        }

        const next = key[index + 1];

        index += 2;

        if (next === 0x01) {
          break;
        }

        if (next !== top) {
          throw malformedKey();
        }

        text.push(0x00);
      }

      try {
        values.push(decoder.decode(Uint8Array.from(text)));
      } catch {
        throw malformedKey();
      }
    } else {
      throw malformedKey();
    }
  }

  return values;
};

/** Bytewise comparison: negative, zero or positive, like `Array.prototype.sort` wants. */
export const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] as number) - (right[index] as number);

    if (difference !== 0) {
      return difference;
    }
  }

  return left.length - right.length;
};

/** Document IDs break index ties bytewise in UTF-8 (PostgreSQL `COLLATE "C"`). */
export const compareIds = (left: string, right: string): number =>
  compareBytes(encoder.encode(left), encoder.encode(right));

/** The JSON Pointer of an index field: `a.b` → `/a/b` (RFC 6901 escapes). */
export const toJsonPointer = (field: string): string =>
  field
    .split('.')
    .map((segment) => `/${segment.replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('');

const segmentsOf = (pointer: string): string[] =>
  pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));

const resolvePointer = (value: unknown, pointer: string): unknown => {
  let current = value;

  for (const segment of segmentsOf(pointer)) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) {
        return undefined;
      }

      current = current[Number(segment)];
    } else if (
      typeof current === 'object' &&
      current !== null &&
      Object.hasOwn(current, segment)
    ) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }

  return current;
};

/**
 * Extracts one value per index field by JSON Pointer. A missing path is
 * `null`; an object or an array is `invalid_index_value`.
 */
export const indexValues = (
  value: unknown,
  fields: readonly string[],
): IndexScalar[] =>
  fields.map((field) => {
    const found = resolvePointer(value, toJsonPointer(field));

    if (found === undefined || found === null) {
      return null;
    }

    if (
      typeof found === 'string' ||
      typeof found === 'number' ||
      typeof found === 'boolean'
    ) {
      return found;
    }

    throw invalidValue(
      `The index field "${field}" holds ${Array.isArray(found) ? 'an array' : `a ${typeof found}`}; only strings, numbers, booleans and null can be indexed.`,
    );
  });

const concat = (...parts: readonly (Uint8Array | readonly number[])[]) => {
  const out: number[] = [];

  for (const part of parts) {
    out.push(...part);
  }

  return Uint8Array.from(out);
};

/**
 * Byte bounds `[lower, upper)` of the keys a query selects: equality on the
 * leading fields, then an optional range on the next one. `gt`/`gte` and
 * `lt`/`lte` exclude each other; giving both of a pair is `invalid_input`.
 */
export const keyBounds = (
  query: Pick<StorageQuery, 'equals' | 'range'>,
): { lower: Uint8Array; upper: Uint8Array } => {
  const prefix = encodeIndexKey(query.equals);
  const range = query.range ?? {};

  if (range.gt !== undefined && range.gte !== undefined) {
    throw new ContractError(
      'invalid_input',
      'A range takes either gt or gte, not both.',
    );
  }

  if (range.lt !== undefined && range.lte !== undefined) {
    throw new ContractError(
      'invalid_input',
      'A range takes either lt or lte, not both.',
    );
  }

  const lower =
    range.gt !== undefined
      ? concat(prefix, encodeIndexKey([range.gt]), [top])
      : range.gte !== undefined
        ? concat(prefix, encodeIndexKey([range.gte]))
        : prefix;
  const upper =
    range.lt !== undefined
      ? concat(prefix, encodeIndexKey([range.lt]))
      : range.lte !== undefined
        ? concat(prefix, encodeIndexKey([range.lte]), [top])
        : concat(prefix, [top]);

  return { lower, upper };
};
