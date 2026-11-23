// Builds a bundle's host part: `src/host/main.ts` into one self-contained ESM
// file, `dist/host/main.mjs`, that a dev bundle's host process runs with
// `node` (spec §14, "Packaging and build" step 1). Loaded on demand from
// cli.ts like parts.ts; esbuild and typescript are imported lazily, so the
// host runtime never loads them.

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import type { Node, SourceFile } from 'typescript';

/** Defines `require` in the ESM output for the CommonJS code esbuild inlines. */
const requireBanner =
  "import { createRequire as __doricCreateRequire } from 'node:module';\n" +
  'const require = __doricCreateRequire(import.meta.url);';

export class HostBuildError extends Error {
  override readonly name = 'HostBuildError';
}

export interface HostBuildOptions {
  /** The bundle project directory (with `manifest.json` and `src/`). */
  readonly bundleDir: string;
}

/**
 * Builds `<bundleDir>/src/host/main.ts` into `<bundleDir>/dist/host/main.mjs`.
 *
 * Accepts the bundle project directory. Resolves `false` and writes nothing
 * when `src/host/main.ts` does not exist; resolves `true` after writing
 * `dist/host/main.mjs` (creating `dist/host` when needed).
 *
 * The output is one ESM file for Node (target node26) with every dependency
 * bundled in, `node:*` built-ins left external, and a banner that defines
 * `require` from `createRequire(import.meta.url)`, so bundled CommonJS code
 * that calls `require` keeps working.
 *
 * Fails, writing no `dist/host/main.mjs`:
 * - with a HostBuildError when any loaded `.js`, `.mjs`, `.cjs`, `.jsx`,
 *   `.ts`, `.mts`, `.cts` or `.tsx` file (node_modules included) contains an
 *   `import(x)` whose argument is neither a string literal nor a
 *   substitution-free template literal; its message lists each such call as
 *   `<path>:<line>`, one per occurrence;
 * - with esbuild's own error (message containing "no loader is configured"
 *   and naming the file) when the build reaches a `.node` native addon;
 * - with the esbuild failure for any other build error.
 */
export const buildHostPart = async (
  options: HostBuildOptions,
): Promise<boolean> => {
  const root = resolve(options.bundleDir);
  const entry = join(root, 'src', 'host', 'main.ts');
  const outfile = join(root, 'dist', 'host', 'main.mjs');

  try {
    await access(entry);
  } catch {
    return false;
  }

  const [{ build }, { default: ts }] = await Promise.all([
    import('esbuild'),
    import('typescript'),
  ]);
  const found: string[] = [];

  const visit = (file: SourceFile, node: Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [argument] = node.arguments;

      if (
        argument === undefined ||
        !(
          ts.isStringLiteral(argument) ||
          ts.isNoSubstitutionTemplateLiteral(argument)
        )
      ) {
        const { line } = file.getLineAndCharacterOfPosition(
          node.getStart(file),
        );

        found.push(
          `${relative(root, file.fileName).split(sep).join('/')}:${line + 1}`,
        );
      }
    }

    ts.forEachChild(node, (child) => visit(file, child));
  };

  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node26',
    outfile,
    external: ['node:*'],
    banner: { js: requireBanner },
    plugins: [
      {
        name: 'dynamic-import-guard',
        setup(pluginBuild) {
          pluginBuild.onLoad(
            { filter: /\.[cm]?[jt]sx?$/ },
            async ({ path }) => {
              const source = await readFile(path, 'utf8');

              if (/\bimport\s*\(/.test(source)) {
                const file = ts.createSourceFile(
                  path,
                  source,
                  ts.ScriptTarget.Latest,
                  true,
                );

                visit(file, file);
              }

              return undefined;
            },
          );
        },
      },
    ],
    logLevel: 'silent',
    write: false,
  });

  if (found.length > 0) {
    throw new HostBuildError(
      `A dynamic import() of the host part has an argument that is not a string literal:\n${found.sort().join('\n')}`,
    );
  }

  const [output] = result.outputFiles;

  if (output === undefined) {
    throw new HostBuildError(`esbuild wrote no ${outfile}`);
  }

  await mkdir(dirname(outfile), { recursive: true });
  await writeFile(outfile, output.contents);

  return true;
};
