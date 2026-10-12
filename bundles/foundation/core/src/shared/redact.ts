// The redaction and storability rules of the host, copied from
// `agents/doric` (`credentials/redact.ts`, `events/serialization.ts` and
// `workspace/storage.ts`). Both copies are pinned to the same fixtures until
// the kernel copy leaves in stage 5.

/** The one marker a redacted secret leaves in its place. */
const redacted = '[REDACTED]';

/**
 * Replaces every literal occurrence of each secret with the redaction marker.
 * Empty secrets are ignored, because an empty needle would otherwise redact
 * between every character. Secrets are applied in order, so a later secret may
 * also match text an earlier replacement introduced.
 */
export const redactSecrets = (
  text: string,
  secrets: readonly string[],
): string =>
  secrets.reduce(
    (current, secret) =>
      secret === '' ? current : current.split(secret).join(redacted),
    text,
  );

/**
 * Text PostgreSQL can store. It rejects U+0000 in any string and an unpaired
 * surrogate in jsonb, so those become U+FFFD.
 */
export const storable = (text: string): string =>
  Array.from(text, (character) => {
    const code = character.codePointAt(0) ?? 0;

    return code === 0 || (code >= 0xd800 && code <= 0xdfff)
      ? '\uFFFD'
      : character;
  }).join('');

const marker = (name: string, detail?: string): string =>
  detail === undefined ? `[${name}]` : `[${name}: ${detail}]`;

/**
 * Whether a value is a plain record: an object literal, or one built with no
 * prototype. Only such a value is JSON `{}` when it holds no property; anything
 * else that exposes none is marked instead, because its contents are not the
 * model's to read.
 */
const isPlainRecord = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
};

/** Converts arbitrary event values into redacted, cycle-safe JSON values. */
export const eventJson = (
  value: unknown,
  credentials: readonly string[],
): unknown => {
  const seen = new WeakMap<object, string>();
  const redact = (text: string): string => redactSecrets(text, credentials);
  const visit = (current: unknown, path: string): unknown => {
    if (current === null || typeof current === 'boolean') {
      return current;
    }

    if (typeof current === 'string') {
      return redact(current);
    }

    if (typeof current === 'number') {
      if (Number.isNaN(current)) {
        return marker('NaN');
      }

      if (current === Number.POSITIVE_INFINITY) {
        return marker('Infinity');
      }

      if (current === Number.NEGATIVE_INFINITY) {
        return marker('-Infinity');
      }

      return current;
    }

    if (typeof current === 'undefined') {
      return marker('Undefined');
    }

    if (typeof current === 'bigint') {
      return marker('BigInt', String(current));
    }

    if (typeof current === 'symbol') {
      return marker('Symbol', redact(current.description ?? ''));
    }

    if (typeof current === 'function') {
      return marker('Function', redact(current.name || 'anonymous'));
    }

    const previous = seen.get(current);

    if (previous !== undefined) {
      return marker('Circular', previous);
    }

    seen.set(current, path);

    if (current instanceof Date) {
      return Number.isNaN(current.getTime())
        ? marker('Invalid Date')
        : current.toISOString();
    }

    if (current instanceof RegExp) {
      return marker('RegExp', redact(String(current)));
    }

    if (ArrayBuffer.isView(current)) {
      return Array.from(
        new Uint8Array(current.buffer, current.byteOffset, current.byteLength),
      );
    }

    if (current instanceof ArrayBuffer) {
      return Array.from(new Uint8Array(current));
    }

    if (Array.isArray(current)) {
      return current.map((entry, index) => visit(entry, `${path}[${index}]`));
    }

    const names = new Set(Object.getOwnPropertyNames(current));

    if (current instanceof Error) {
      names.add('name');
      names.add('message');
      names.add('stack');
      names.add('cause');
    }

    // A plain record with no own property is the empty object, and JSON spells
    // it `{}`; the marker is for a value whose properties are not the model's to
    // read, such as a Map, a Set, or a class instance keeping its state private.
    if (names.size === 0 && !isPlainRecord(current)) {
      return marker(
        current.constructor?.name ?? 'Object',
        // The marker deliberately describes opaque instances by their string form.
        redact(String(current)),
      );
    }

    return Object.fromEntries(
      [...names].flatMap<[string, unknown]>((name) => {
        let entry: unknown;

        try {
          entry = Reflect.get(current, name);
        } catch {
          entry = marker('Unserializable property');
        }

        return entry === undefined
          ? []
          : [[redact(name), visit(entry, `${path}.${name}`)]];
      }),
    );
  };

  return visit(value, '$');
};

/**
 * What a durable event body becomes before it is written: redacted by
 * `eventJson`, then every string made storable, as the kernel's `json()` does.
 */
export const redactJson = (
  value: unknown,
  credentials: readonly string[],
): unknown =>
  JSON.parse(
    JSON.stringify(eventJson(value, credentials), (_key, entry: unknown) =>
      typeof entry === 'string' ? storable(entry) : entry,
    ) ?? 'null',
  ) as unknown;

/**
 * Redacts every string leaf of records, arrays, Errors (with their name,
 * message, stack and cause) and class instances with enumerable properties,
 * which become plain copies; every other value is kept as it is. Used for log fields, which are written by
 * the host's log destinations rather than stored.
 */
export const redactLeaves = (
  value: unknown,
  secrets: readonly string[],
): unknown => {
  const seen = new WeakMap<object, unknown>();
  const visit = (current: unknown): unknown => {
    if (typeof current === 'string') {
      return redactSecrets(current, secrets);
    }

    if (typeof current !== 'object' || current === null) {
      return current;
    }

    const known = seen.get(current);

    if (known !== undefined) {
      return known;
    }

    if (Array.isArray(current)) {
      const copy: unknown[] = [];

      seen.set(current, copy);
      copy.push(...current.map(visit));

      return copy;
    }

    const names = Object.keys(current);

    if (current instanceof Error) {
      // An Error's message, stack and cause are own but not enumerable; the
      // log destinations still write them, so they are copied and redacted.
      for (const name of ['name', 'message', 'stack', 'cause']) {
        if (!names.includes(name) && Reflect.get(current, name) !== undefined) {
          names.push(name);
        }
      }
    } else if (!isPlainRecord(current) && names.length === 0) {
      // An instance exposing no enumerable property (a Date, a Map) is written
      // without its contents, so it is kept as it is.
      return current;
    }

    const copy: Record<string, unknown> = {};

    seen.set(current, copy);

    for (const name of names) {
      let entry: unknown;

      try {
        entry = Reflect.get(current, name);
      } catch {
        entry = '[Unserializable property]';
      }

      copy[name] = visit(entry);
    }

    return copy;
  };

  return visit(value);
};
