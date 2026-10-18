// Who may reach a method from outside its process. Kept free of imports so the
// definitions, the specifications and the runtime can all depend on it.

/** A method exposure: `desktop` is the only target, a desktop window's bridge call. */
export const methodExposures = ['desktop'] as const;

export type MethodExposure = (typeof methodExposures)[number];

export const isMethodExposure = (value: unknown): value is MethodExposure =>
  (methodExposures as readonly unknown[]).includes(value);
