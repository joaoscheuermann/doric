import { ContractError, isContractError } from '../../contracts/error.js';
import type {
  WireError,
  WireOwnProperty,
  WireThrownError,
} from './messages.js';

type ErrorClass = abstract new (...args: never[]) => Error;

/** The error classes a process can rebuild with their own prototype. */
export interface ErrorClassRegistry {
  register(errorClass: ErrorClass): void;
  /** The registered class of that constructor name, if any. */
  lookup(name: string): ErrorClass | undefined;
}

/** A registry that always knows `ContractError`. */
export const createErrorClassRegistry = (): ErrorClassRegistry => {
  const classes = new Map<string, ErrorClass>([
    ['ContractError', ContractError],
  ]);

  return {
    register: (errorClass) => {
      classes.set(errorClass.name, errorClass);
    },
    lookup: (name) => classes.get(name),
  };
};

const standardErrors: Readonly<Record<string, ErrorClass | undefined>> = {
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  ReferenceError,
  EvalError,
  URIError,
  AggregateError:
    typeof AggregateError === 'undefined' ? undefined : AggregateError,
};

const isError = (value: unknown): value is Error =>
  value instanceof Error ||
  Object.prototype.toString.call(value) === '[object Error]' ||
  (typeof DOMException !== 'undefined' && value instanceof DOMException);

const functionMarker = (value: (...args: never[]) => unknown): string =>
  `[Function: ${value.name || 'anonymous'}]`;

/**
 * A structured-clonable copy of an own property value. Functions and symbols
 * become the marker `eventJson` would print; anything else uncloneable is
 * walked so its clonable parts survive.
 */
const clonable = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (typeof value === 'function') {
    return functionMarker(value as () => unknown);
  }

  if (typeof value === 'symbol') {
    return `[Symbol: ${value.description ?? ''}]`;
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  try {
    structuredClone(value);

    return value;
  } catch {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((entry) => clonable(entry, seen));
    }

    return Object.fromEntries(
      Object.keys(value).map((key) => [
        key,
        clonable((value as Record<string, unknown>)[key], seen),
      ]),
    );
  }
};

const encodeThrown = (error: Error, seen: WeakSet<object>): WireThrownError => {
  seen.add(error);

  const own: WireOwnProperty[] = [];

  for (const key of Object.getOwnPropertyNames(error)) {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);

    if (descriptor === undefined) {
      continue;
    }

    let value: unknown;

    try {
      value =
        'value' in descriptor ? descriptor.value : Reflect.get(error, key);
    } catch {
      value = '[Unserializable property]';
    }

    const enumerable = descriptor.enumerable === true;

    if (isError(value) && !seen.has(value)) {
      own.push({ key, enumerable, error: encodeThrown(value, seen) });
    } else {
      own.push({ key, enumerable, value: clonable(value) });
    }
  }

  const name = Reflect.get(error, 'name');

  return {
    kind: 'error',
    name: typeof name === 'string' ? name : 'Error',
    prototype:
      (error.constructor as { name?: unknown } | undefined)?.name === undefined
        ? 'Error'
        : String((error.constructor as { name: unknown }).name),
    own,
  };
};

/** Encodes any thrown value for a `result` message. */
export const encodeError = (value: unknown): WireError => {
  if (isError(value)) {
    const code = isContractError(value) ? value.code : 'internal';
    const details = isContractError(value)
      ? clonable(value.details)
      : undefined;

    return {
      code,
      message: String(Reflect.get(value, 'message') ?? ''),
      ...(details === undefined ? {} : { details }),
      thrown: encodeThrown(value, new WeakSet()),
    };
  }

  return {
    code: 'internal',
    message:
      typeof value === 'string'
        ? value
        : isContractError(value)
          ? value.message
          : 'Internal error.',
    thrown: { kind: 'value', value: clonable(value) },
  };
};

const prototypeFor = (
  wire: WireThrownError,
  classes: ErrorClassRegistry,
): object => {
  const known =
    classes.lookup(wire.prototype) ?? standardErrors[wire.prototype];
  const base: object = known?.prototype ?? Error.prototype;
  const ownName = wire.own.some(({ key }) => key === 'name');

  if (ownName || Reflect.get(base, 'name') === wire.name) {
    return base;
  }

  // Keeps `name` off the own properties while reading as it did.
  return Object.create(base, {
    name: {
      value: wire.name,
      writable: true,
      configurable: true,
      enumerable: false,
    },
  }) as object;
};

const decodeThrown = (
  wire: WireThrownError,
  classes: ErrorClassRegistry,
): unknown => {
  let target: object;

  if (
    wire.prototype === 'DOMException' &&
    typeof DOMException !== 'undefined'
  ) {
    const message = wire.own.find(({ key }) => key === 'message');

    target = new DOMException(
      message !== undefined && 'value' in message ? String(message.value) : '',
      wire.name,
    );
  } else {
    target = Object.create(prototypeFor(wire, classes)) as object;
  }

  for (const property of wire.own) {
    const value =
      'error' in property
        ? decodeThrown(property.error, classes)
        : property.value;

    try {
      Object.defineProperty(target, property.key, {
        value,
        enumerable: property.enumerable,
        writable: true,
        configurable: true,
      });
    } catch {
      // A host object refused the property; the rest still applies.
    }
  }

  return target;
};

/** Rebuilds what the other side threw; a ContractError stays a ContractError. */
export const decodeError = (
  wire: WireError,
  classes: ErrorClassRegistry,
): unknown => {
  if (wire.thrown === undefined) {
    return new ContractError(wire.code, wire.message, wire.details);
  }

  if (wire.thrown.kind === 'value') {
    return wire.thrown.value;
  }

  return decodeThrown(wire.thrown, classes);
};
