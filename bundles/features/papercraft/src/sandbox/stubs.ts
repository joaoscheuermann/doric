// D12's stubs: what an import from outside `schemas/` evaluates to while the
// runner takes the signatures. A stub value may be called, constructed and
// read through, so module-scope calls (`forwardRef(…)`, `cva(…)`,
// `styled.div`) evaluate; turning it into a primitive, iterating it or
// enumerating it throws `StubReadError`, so a schema that reads a value from
// outside `schemas/` fails naming the import.

/** Where a stub comes from: the importing file and the import's specifier. */
export interface StubOrigin {
  readonly importer: string;
  readonly specifier: string;
}

/** A schema read a stub's value. */
export class StubReadError extends Error {
  constructor(
    readonly origin: StubOrigin,
    readonly path: readonly string[],
  ) {
    super(
      `${origin.importer}: the schema reads \`${path[0] ?? 'default'}\` from \`${origin.specifier}\`, which is outside schemas/. Schema values must come from schemas/ or from zod.`,
    );
    this.name = 'StubReadError';
  }
}

/** The stubs of one evaluation, and how to tell one. */
export interface Stubs {
  /** The `module.exports` of one stub module (`bundle.ts`'s `STUB_NS`). */
  readonly module: (origin: StubOrigin) => unknown;
  readonly isStub: (value: unknown) => boolean;
  /** The origin and path of a stub, for the error that names it. */
  readonly describe: (value: unknown) => StubReadError | undefined;
}

export const createStubs = (): Stubs => {
  const created = new WeakMap<object, StubReadError>();

  const value = (origin: StubOrigin, path: readonly string[]): unknown => {
    const fail = (): never => {
      throw new StubReadError(origin, path);
    };
    // A bound function: callable, constructible, and without the
    // non-configurable `prototype` an enumeration trap would have to report.
    const target = function stub() {}.bind(null);
    const proxy: object = new Proxy(target, {
      apply: () => value(origin, [...path, '()']),
      construct: () => value(origin, [...path, 'new']) as object,
      get: (_, key) => {
        if (key === 'then' || key === '$$typeof') return undefined;
        if (
          key === Symbol.toPrimitive ||
          key === 'valueOf' ||
          key === 'toString' ||
          key === Symbol.iterator
        ) {
          return fail;
        }

        return typeof key === 'symbol'
          ? undefined
          : value(origin, [...path, key]);
      },
      ownKeys: fail,
      has: fail,
      getOwnPropertyDescriptor: fail,
    });

    created.set(proxy, new StubReadError(origin, path));

    return proxy;
  };

  /**
   * A module's exports: esbuild's `__toESM` copies its own keys (none) and
   * reads named imports through its prototype, which answers a stub per name.
   */
  const module = (origin: StubOrigin): unknown => {
    const names = new Proxy(
      {},
      {
        get: (_, key) =>
          typeof key === 'string' && key !== 'then' && key !== '__esModule'
            ? value(origin, [key])
            : undefined,
      },
    );
    // The default export is the module itself, a stub like any other.
    const exported = value(origin, []) as object;
    const proxy: object = new Proxy(function stubModule() {}.bind(null), {
      apply: () => value(origin, ['()']),
      construct: () => value(origin, ['new']) as object,
      get: (_, key) =>
        key === '__esModule' ? undefined : Reflect.get(exported, key),
      getPrototypeOf: () => names,
      ownKeys: () => [],
      has: () => false,
      getOwnPropertyDescriptor: () => undefined,
    });

    created.set(proxy, new StubReadError(origin, []));

    return proxy;
  };

  return {
    module,
    isStub: (candidate) =>
      typeof candidate === 'function' && created.has(candidate),
    describe: (candidate) =>
      typeof candidate === 'function' ? created.get(candidate) : undefined,
  };
};
