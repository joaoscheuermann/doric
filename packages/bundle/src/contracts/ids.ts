/** A versioned contract ID: `<bundle>.<name>/v<major>` or a basic `<domain>/v<major>`. */
export type ContractId = `${string}/v${number}`;

/** The three places a bundle part can run. */
export type Environment = 'host' | 'desktopMain' | 'client';

export const environments: readonly Environment[] = Object.freeze([
  'host',
  'desktopMain',
  'client',
]);

/** Lowercase segments separated by `.`, then `/v` and a positive major. */
export const contractIdPattern =
  /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\/v[1-9][0-9]*$/;

/** Bundle IDs: one lowercase segment, never `doric`. */
export const bundleIdPattern = /^[a-z][a-z0-9-]*$/;

/** The identity the platform uses as caller and owner of `doric.*` contracts. */
export const PLATFORM_BUNDLE_ID = 'doric';

export const isContractId = (value: unknown): value is ContractId =>
  typeof value === 'string' && contractIdPattern.test(value);

/** Platform contracts always exist and never appear in `provides`/`requires`. */
export const isPlatformContract = (id: string): boolean =>
  id.startsWith(`${PLATFORM_BUNDLE_ID}.`);

/** The major version encoded in a contract ID (`git.commands/v2` → 2). */
export const majorOf = (id: string): number => {
  const match = /\/v([1-9][0-9]*)$/.exec(id);

  if (match === null) {
    throw new TypeError(`Invalid contract ID "${id}".`);
  }

  return Number(match[1]);
};
