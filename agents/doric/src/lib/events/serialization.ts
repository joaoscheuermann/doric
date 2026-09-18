const marker = (name: string, detail?: string): string =>
  detail === undefined ? `[${name}]` : `[${name}: ${detail}]`;

/** Converts arbitrary agent events into redacted, cycle-safe JSON values. */
export const eventJson = (
  value: unknown,
  credentials: readonly string[],
): unknown => {
  const seen = new WeakMap<object, string>();
  const redact = (text: string): string =>
    credentials.reduce(
      (result, credential) => result.split(credential).join('[REDACTED]'),
      text,
    );

  const visit = (current: unknown, path: string): unknown => {
    if (current === null || typeof current === 'boolean') return current;
    if (typeof current === 'string') return redact(current);
    if (typeof current === 'number') {
      if (Number.isNaN(current)) return marker('NaN');
      if (current === Number.POSITIVE_INFINITY) return marker('Infinity');
      if (current === Number.NEGATIVE_INFINITY) return marker('-Infinity');
      return current;
    }
    if (typeof current === 'undefined') return marker('Undefined');
    if (typeof current === 'bigint') return marker('BigInt', String(current));
    if (typeof current === 'symbol')
      return marker('Symbol', redact(current.description ?? ''));
    if (typeof current === 'function')
      return marker('Function', redact(current.name || 'anonymous'));

    const previous = seen.get(current);
    if (previous !== undefined) return marker('Circular', previous);
    seen.set(current, path);

    if (current instanceof Date)
      return Number.isNaN(current.getTime())
        ? marker('Invalid Date')
        : current.toISOString();
    if (current instanceof RegExp)
      return marker('RegExp', redact(String(current)));
    if (ArrayBuffer.isView(current))
      return Array.from(
        new Uint8Array(current.buffer, current.byteOffset, current.byteLength),
      );
    if (current instanceof ArrayBuffer)
      return Array.from(new Uint8Array(current));
    if (Array.isArray(current))
      return current.map((entry, index) => visit(entry, `${path}[${index}]`));

    const names = new Set(Object.getOwnPropertyNames(current));
    if (current instanceof Error) {
      names.add('name');
      names.add('message');
      names.add('stack');
      names.add('cause');
    }
    if (names.size === 0)
      return marker(
        current.constructor?.name ?? 'Object',
        redact(String(current)),
      );

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
