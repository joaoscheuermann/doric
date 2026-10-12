// The resolution of the desktopMain utility process: the bare specifiers of
// the generation's import map (`bundle/contracts`, `zod`, `<id>/contracts`)
// become `file://` URLs; anything else falls through (Node built-ins; parts
// bundle everything else).

export interface ResolveContext {
  readonly parentURL?: string;
}

export interface ResolveResult {
  readonly url: string;
  readonly shortCircuit?: boolean;
  readonly format?: string;
}

export type NextResolve = (
  specifier: string,
  context?: ResolveContext,
) => ResolveResult;

/**
 * `moduleRoots`: `file://` prefixes whose `.js` files are ES modules (the
 * platform packages and the artifact cache carry no `package.json` type).
 */
export const createResolveHook =
  (
    imports: Readonly<Record<string, string>>,
    moduleRoots: readonly string[] = [],
  ) =>
  (
    specifier: string,
    context: ResolveContext,
    nextResolve: NextResolve,
  ): ResolveResult => {
    const target = Object.hasOwn(imports, specifier)
      ? imports[specifier]
      : undefined;

    if (target !== undefined) {
      return { url: target, shortCircuit: true, format: 'module' };
    }

    const resolved = nextResolve(specifier, context);

    return /\.m?js$/.test(resolved.url) &&
      moduleRoots.some((root) => resolved.url.startsWith(root))
      ? { ...resolved, format: 'module' }
      : resolved;
  };

/** What main hands the runner on its command line (one JSON argument). */
export interface RunnerArguments {
  /** Bare specifier → file URL. */
  readonly imports: Readonly<Record<string, string>>;
  /** Bundle ID → file URL of its desktopMain part. */
  readonly parts: Readonly<Record<string, string>>;
  /** `file://` prefixes whose `.js` files are ES modules. */
  readonly moduleRoots?: readonly string[];
}

export const RUNNER_ARGUMENT_PREFIX = '--doric-runner=';

export const encodeRunnerArguments = (args: RunnerArguments): string =>
  `${RUNNER_ARGUMENT_PREFIX}${Buffer.from(JSON.stringify(args)).toString('base64')}`;

export const decodeRunnerArguments = (
  argv: readonly string[],
): RunnerArguments => {
  const argument = argv.find((value) =>
    value.startsWith(RUNNER_ARGUMENT_PREFIX),
  );

  if (argument === undefined) {
    throw new Error('The generation runner was started without its arguments.');
  }

  return JSON.parse(
    Buffer.from(
      argument.slice(RUNNER_ARGUMENT_PREFIX.length),
      'base64',
    ).toString('utf8'),
  ) as RunnerArguments;
};
