/**
 * The header of a contract `.proto`: its first line,
 * "// `<id>` (<environment words>, <version>[, …])" (for example
 * "// `runtime.threads/v1` (host, 1.10.0): …", "// `papercraft.cwd/v1`
 * (host event, 1.1.0, D10)").
 * @typedef {{ id: string, environment: 'host' | 'client', version: string | undefined, path: string }} ProtoHeader
 */

/**
 * The headers of `files` (each `{ path, source }`, the `.proto` files under
 * `bundles/<group>/<id>/proto/doric/` and `packages/bundle/proto/doric/`), in
 * `files` order. `environment` is the first word inside the parentheses;
 * `version` is the first `<major>.<minor>.<patch>` there, `undefined` when
 * there is none ("(host, until phase 4)"). A file whose first line is not a
 * header is skipped. Pure; never throws.
 * @param {ReadonlyArray<{ path: string, source: string }>} files
 * @returns {ProtoHeader[]}
 */
export const protoHeaders = (files) =>
  files.flatMap(({ path, source }) => {
    const match = /^\/\/ `([^`]+)` \(([^)\n]*)/.exec(source);

    if (match === null) {
      return [];
    }

    const [, id, words] = match;

    return [
      {
        id,
        environment: /^\s*([a-z]+)/.exec(words)?.[1],
        version: /\d+\.\d+\.\d+/.exec(words)?.[0],
        path,
      },
    ];
  });

/**
 * Check of plan Q5 (group D): every `provides` entry `<id>@<version>` of every
 * manifest of `bundles` whose header (by `id`) says `host` and carries a
 * version must carry that version. A `client` header, a header without a
 * version, and an id without a header are not checked.
 *
 * Answers one finding per mismatch, `{ bundle, id, provides, header }`, in
 * bundle order then `provides` order; `[]` when every entry matches. Pure;
 * never throws.
 * @param {ReadonlyArray<{ id: string, manifest: { provides?: string[] } }>} bundles
 * @param {ReadonlyArray<ProtoHeader>} headers
 * @returns {Array<{ bundle: string, id: string, provides: string, header: string }>}
 */
export const findProvideVersionDrift = (bundles, headers) => {
  const byId = new Map(headers.map((header) => [header.id, header]));

  return bundles.flatMap((bundle) =>
    (bundle.manifest.provides ?? []).flatMap((entry) => {
      const at = entry.indexOf('@');
      const id = at < 0 ? entry : entry.slice(0, at);
      const provides = at < 0 ? '' : entry.slice(at + 1);
      const header = byId.get(id);

      if (
        header === undefined ||
        header.environment !== 'host' ||
        header.version === undefined ||
        header.version === provides
      ) {
        return [];
      }

      return [{ bundle: bundle.id, id, provides, header: header.version }];
    }),
  );
};
