export type SessionEntry<Value> = {
  readonly id: string;
  readonly value: Value;
};

export interface SessionStore<Value> {
  get(id: string): Value | undefined;

  load(id: string): Promise<Value> | undefined;

  getOrCreate(id: string, create: () => Value | Promise<Value>): Promise<Value>;

  delete(id: string): boolean;

  list(): readonly SessionEntry<Value>[];

  clear(): void;
}

type InFlightSession<Value> = {
  readonly promise: Promise<Value>;
  readonly token: symbol;
};

/** Creates a process-local in-memory session store keyed by string IDs. */
export const createSessionStore = <Value>(): SessionStore<Value> => {
  const values = new Map<string, Value>();
  const inFlight = new Map<string, InFlightSession<Value>>();

  return {
    get(id) {
      return values.get(id);
    },

    load(id) {
      if (values.has(id)) {
        return Promise.resolve(values.get(id) as Value);
      }

      return inFlight.get(id)?.promise;
    },

    getOrCreate(id, create) {
      if (values.has(id)) {
        return Promise.resolve(values.get(id) as Value);
      }

      const existing = inFlight.get(id);

      if (existing !== undefined) {
        return existing.promise;
      }

      const token = Symbol(id);

      const promise = Promise.resolve()
        .then(create)
        .then(
          (value) => {
            if (inFlight.get(id)?.token === token) {
              values.set(id, value);

              inFlight.delete(id);
            }

            return value;
          },
          (error: unknown) => {
            if (inFlight.get(id)?.token === token) {
              inFlight.delete(id);
            }

            throw error;
          },
        );

      inFlight.set(id, { promise, token });

      return promise;
    },

    delete(id) {
      const existed = values.delete(id);
      const wasInFlight = inFlight.delete(id);

      return existed || wasInFlight;
    },

    list() {
      return [...values.entries()].map(([id, value]) => ({ id, value }));
    },

    clear() {
      values.clear();

      inFlight.clear();
    },
  };
};
