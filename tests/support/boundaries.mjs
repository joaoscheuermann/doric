/**
 * Pure finders for the six boundary checks of `docs/designs/bundle-isolation.md` section 1.
 *
 * No function here reads the disk or the environment. Each one works on the
 * `Snapshot` it is given, never changes it, and returns new arrays.
 *
 * Paths: every path a caller passes in, and every path a finding holds, is
 * relative to the repository root and uses `/`, for example
 * `bundles/foundation/core/src/desktop/commands.ts`.
 *
 * Every finder guarantees that:
 * - each finding has `check` set to the finder's check;
 * - findings are unique by `(bundle, target)`;
 * - findings are sorted by `bundle`, then `target`, in code-unit order;
 * - a snapshot with no violation gives `[]`.
 */

import { importedModules } from './workspace.mjs';

/** @typedef {'imports'|'declared'|'cycles'|'core'|'lists'|'dependencies'} Check */

/**
 * One violation. What `bundle` and `target` hold depends on `check`; the
 * comment of each finder says what.
 * @typedef {{ check: Check, bundle: string, target: string }} Finding
 */

/**
 * One item of `violations` in `tests/boundary-exceptions.json`, whose shape
 * is `{ "violations": Entry[] }`.
 * - `decision`: root-relative path of the document that records why the
 *   violation is tolerated.
 * - `until`: the phase or step that removes the entry, such as `phase 9` or
 *   `step 4(d)`.
 * - For `cycles`, `bundle` and `target` are the edge's from and to ends.
 * @typedef {Finding & { decision: string, until?: string }} Entry
 */

/**
 * @typedef {{ path: string, source: string }} SourceFile
 * `path` is root-relative; `source` is the file's text.
 */

/**
 * @typedef {{ id: string, directory: string, manifest: object, packageJson: object }} Bundle
 * - `id` is `manifest.id`, which equals `packageJson.name` for every bundle.
 * - `directory` is root-relative, for example `bundles/foundation/core`.
 */

/**
 * @typedef {{
 *   files: SourceFile[],            // sourceFiles(root) under packages, app, tools, bundles
 *   packages: string[],             // workspacePackageNames()
 *   packageDirectories: Readonly<Record<string, string>>, // root-relative package directory -> package name, for every workspace package
 *   bundles: Bundle[],              // the 31 manifests and package.json files
 *   buildFiles: SourceFile[],       // doric-host project.json and .Dockerfile
 *   composition: object             // doric-host composition.json
 * }} Snapshot
 */

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const byFinding = (a, b) =>
  compare(a.bundle, b.bundle) || compare(a.target, b.target);

const collector = (check) => {
  const seen = new Map();
  return {
    add: (bundle, target) => {
      const key = `${bundle}\0${target}`;
      if (!seen.has(key)) seen.set(key, { check, bundle, target });
    },
    list: () => [...seen.values()].sort(byFinding),
  };
};

const withoutVersion = (line) => {
  const at = line.indexOf('@');
  return at === -1 ? line : line.slice(0, at);
};

const linesOf = (manifest, key) =>
  Array.isArray(manifest?.[key]) ? manifest[key] : [];

const bundleOfPath = (bundles, path) =>
  bundles.find((bundle) => path.startsWith(`${bundle.directory}/`));

const blankComments = (source) =>
  source
    .split('\n')
    .map((line) => (/^\s*(?:\/\/|\/\*|\*)/u.test(line) ? '' : line))
    .join('\n');

const wholeStringLiterals = (source) => {
  const literals = new Set();
  for (const match of source.matchAll(/(?=(['"`])([^'"`\s]+)\1)/gu)) {
    literals.add(match[2]);
  }
  return literals;
};

const providersOf = (bundles) => {
  const providers = new Map();
  for (const bundle of bundles) {
    for (const line of linesOf(bundle.manifest, 'provides')) {
      const id = withoutVersion(line);
      if (id.startsWith('doric.')) continue;
      if (!providers.has(id)) providers.set(id, []);
      if (!providers.get(id).includes(bundle.id)) {
        providers.get(id).push(bundle.id);
      }
    }
  }
  return providers;
};

const usesPackage = (specifier, name) =>
  specifier === name || specifier.startsWith(`${name}/`);

/**
 * Contracts that one bundle declares and others provide, mapped to the id of
 * the declaring bundle.
 *
 * In the graph of `findCycles`, the declarer's line for such a contract gives
 * an edge from each provider to the declarer (`docs/designs/bundle-isolation.md` section 1, `cycles`,
 * "The graph").
 *
 * `default.skill-sources/v1` (declared by `default`) joined it in phase 8;
 * `files.decorations/v1` (declared by `files`) joins it in the phase that
 * creates it.
 * @type {Readonly<Record<string, string>>}
 */
export const declaredContracts = Object.freeze({
  'executor/v1': 'runtime',
  'sandbox/v1': 'runtime',
  'default.skill-sources/v1': 'default',
});

/**
 * Pairs that `findDependencies` treats as used, each with its reason (`docs/designs/bundle-isolation.md`
 * section 1, `dependencies`, rule (5)).
 * @type {ReadonlyArray<Readonly<{ bundle: string, package: string, reason: string }>>}
 */
export const dependencyExceptions = Object.freeze([
  Object.freeze({
    bundle: 'postgres',
    package: '@prisma/client',
    reason:
      'Only the generated Prisma client imports it, and that client is not tracked (bundles/foundation/postgres/src/generated/.gitignore:2).',
  }),
]);

/**
 * Whether `finding` comes from rule (1) of `imports`: an import of a
 * workspace package's `src/` path. No entry may excuse such a finding.
 *
 * True exactly when `finding.check` is `'imports'` and `finding.bundle`
 * contains `/`. A rule (1) finding's `bundle` is a file path, and a bundle id
 * never contains `/`. Applied to an `Entry`, the same test tells whether the
 * entry tries to excuse rule (1).
 * @param {Finding} finding
 * @returns {boolean}
 */
export const isSourcePathImport = (finding) => {
  return finding.check === 'imports' && finding.bundle.includes('/');
};

/**
 * Check `imports` (`docs/designs/bundle-isolation.md` section 1, table row `imports`; M2; D22).
 *
 * Rule (1) applies to every file of `snapshot.files`. Its finding is a
 * specifier, as `importedModules` reads it, that starts with `<name>/src/`
 * for a name in `snapshot.packages`.
 * - `bundle` is the importing file's root-relative path.
 * - `target` is the specifier, verbatim.
 * - A specifier that matches rule (1) is reported by rule (1) only, never
 *   also by rule (2).
 *
 * Rule (2) applies to files under `bundles/<group>/<id>/{src,tests,stories}/`.
 * Its finding is a specifier that is another bundle's package name
 * (`packageJson.name`, other than `<id>`), or that starts with that name and
 * `/`. Three paths are allowed:
 * - exactly `<other>/contracts`, anywhere;
 * - exactly `<other>/testing`, under `tests/` or `stories/`;
 * - exactly `<other>/package.json`, under `tests/` only.
 *
 * Any other path is a finding, including subpaths such as
 * `<other>/contracts/x`: the spec allows `<id>/contracts` alone.
 * - `bundle` is the importing bundle's id.
 * - `target` is the specifier, verbatim.
 *
 * Dynamic imports and the two resolve forms count like static imports,
 * because the specifiers come from `importedModules`.
 * @param {Snapshot} snapshot
 * @returns {Finding[]}
 */
export const findImports = (snapshot) => {
  const found = collector('imports');

  for (const file of snapshot.files) {
    const specifiers = importedModules(file.source);
    const owner = /^bundles\/[^/]+\/[^/]+\/(src|tests|stories)\//u.exec(
      file.path,
    );
    const bundle = owner && bundleOfPath(snapshot.bundles, file.path);
    const area = owner?.[1];

    for (const specifier of specifiers) {
      if (
        snapshot.packages.some((name) => specifier.startsWith(`${name}/src/`))
      ) {
        found.add(file.path, specifier);
        continue;
      }
      if (!bundle) continue;

      for (const other of snapshot.bundles) {
        const name = other.packageJson?.name;
        if (typeof name !== 'string' || name === bundle.id) continue;
        if (name === bundle.packageJson?.name) continue;
        if (!usesPackage(specifier, name)) continue;

        const allowed =
          specifier === `${name}/contracts` ||
          (specifier === `${name}/testing` &&
            (area === 'tests' || area === 'stories')) ||
          (specifier === `${name}/package.json` && area === 'tests');

        if (!allowed) found.add(bundle.id, specifier);
      }
    }
  }

  return found.list();
};

/**
 * Check `declared` (`docs/designs/bundle-isolation.md` section 1, "The rules of four checks", `declared`;
 * M3 (a)).
 *
 * Contract ids:
 * - Every entry of a manifest's `provides`, with its `@version` removed, is a
 *   contract id. Ids that start with `doric.` are skipped.
 * - The providers of an id are the bundles that list it.
 *
 * Comment lines: in every file this check reads, comment lines are blanked
 * before anything is read. A comment line is one whose first non-blank
 * characters are `//`, `/*` or `*`. The number of lines stays the same.
 *
 * A whole string literal of an id is the id preceded and followed by the same
 * quote character, `'`, `"` or a backtick, each kind on its own. So
 * `'runtime.migration/v1'` inside a backtick SQL template counts as one
 * (`bundles/foundation/postgres/src/host/database.ts:68`).
 *
 * Symbols:
 * - They are read from files under `bundles/<group>/<id>/src/contracts/` of
 *   each bundle, and under `packages/bundle/src/contracts/` for the platform
 *   package `bundle`.
 * - A symbol is the name in a line that starts in column 0 with
 *   `export const <Name>`.
 * - Its statement runs to the next line that starts in column 0 with a
 *   letter.
 * - The symbol stands for every contract id written in that statement as a
 *   whole string literal.
 *
 * A use, in a file under `bundles/<group>/<id>/src/`, is one of:
 * - (a) a whole string literal of a contract id;
 * - (b) a name that stands for that symbol's ids. The name is inside the
 *   braces, on one line or several, of `import { … } from
 *   '<package>/contracts'` or from a subpath `'<package>/contracts/…'`.
 *   `<package>` is another bundle's package or `bundle`, and the name is a
 *   symbol of that package. These rules apply:
 *   - `type <Name>` is skipped;
 *   - every name of an `import type { … }` is skipped;
 *   - `<Name> as <Other>` counts as `<Name>`.
 *
 * First kind of finding: bundle B uses an id that B does not provide and
 * does not list under `requires` or `optional` (version range removed).
 * - `bundle` is B, and `target` is the id.
 * - Uses by bundle `core` through symbols of `bundle` are skipped. Its literal
 *   uses still count.
 *
 * Second kind of finding: a line under `requires` or `optional` whose id no
 * manifest provides and does not start with `doric.`.
 * - `bundle` is the bundle whose manifest has the line, and `target` is the id.
 * @param {Snapshot} snapshot
 * @returns {Finding[]}
 */
export const findDeclared = (snapshot) => {
  const found = collector('declared');
  const providers = providersOf(snapshot.bundles);
  const isContract = (id) => providers.has(id);

  // Symbols of each contracts package, by package name.
  const symbols = new Map();
  const contractPackages = [
    ...snapshot.bundles.map((bundle) => ({
      name: bundle.packageJson?.name,
      prefix: `${bundle.directory}/src/contracts/`,
    })),
    { name: 'bundle', prefix: 'packages/bundle/src/contracts/' },
  ];

  for (const { name, prefix } of contractPackages) {
    if (typeof name !== 'string') continue;
    const table = symbols.get(name) ?? new Map();
    symbols.set(name, table);

    for (const file of snapshot.files) {
      if (!file.path.startsWith(prefix)) continue;
      const lines = blankComments(file.source).split('\n');

      for (let index = 0; index < lines.length; index += 1) {
        const match = /^export const ([A-Za-z_$][\w$]*)/u.exec(lines[index]);
        if (!match) continue;

        let end = index + 1;
        while (end < lines.length && !/^[A-Za-z]/u.test(lines[end])) end += 1;

        const ids = [
          ...wholeStringLiterals(lines.slice(index, end).join('\n')),
        ].filter(isContract);
        const known = table.get(match[1]) ?? new Set();
        for (const id of ids) known.add(id);
        table.set(match[1], known);
      }
    }
  }

  for (const file of snapshot.files) {
    if (!/^bundles\/[^/]+\/[^/]+\/src\//u.test(file.path)) continue;
    const bundle = bundleOfPath(snapshot.bundles, file.path);
    if (!bundle) continue;

    const allowed = new Set(
      ['provides', 'requires', 'optional'].flatMap((key) =>
        linesOf(bundle.manifest, key).map(withoutVersion),
      ),
    );
    const use = (id) => {
      if (!allowed.has(id)) found.add(bundle.id, id);
    };
    const source = blankComments(file.source);

    for (const literal of wholeStringLiterals(source)) {
      if (isContract(literal)) use(literal);
    }

    for (const match of source.matchAll(
      /\bimport\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\3/gu,
    )) {
      if (match[1]) continue;
      const contracts = /^(.+?)\/contracts(?:\/.*)?$/u.exec(match[4]);
      if (!contracts) continue;
      const name = contracts[1];
      if (name === bundle.packageJson?.name) continue;
      if (name === 'bundle' && bundle.id === 'core') continue;
      const table = symbols.get(name);
      if (!table) continue;

      for (const item of match[2].split(',')) {
        const text = item.trim();
        if (text === '' || /^type\s/u.test(text)) continue;
        const symbol = text.split(/\s+as\s+/u)[0].trim();
        for (const id of table.get(symbol) ?? []) use(id);
      }
    }
  }

  for (const bundle of snapshot.bundles) {
    for (const key of ['requires', 'optional']) {
      for (const line of linesOf(bundle.manifest, key)) {
        const id = withoutVersion(line);
        if (!id.startsWith('doric.') && !providers.has(id)) {
          found.add(bundle.id, id);
        }
      }
    }
  }

  return found.list();
};

/**
 * Check `cycles` (`docs/designs/bundle-isolation.md` section 1, `cycles`; M3 (b)).
 *
 * The graph is built from the manifests of `snapshot.bundles`. For each
 * bundle B, each id in B's `requires` and `optional` (version range removed),
 * and each provider P of that id other than B, there is one edge:
 * - B → P;
 * - or P → B, when `declaredContracts[id]` is B. Only the declarer's own line
 *   reverses.
 *
 * Ids that start with `doric.` have no providers. Edges form a set: no
 * duplicates and no self-edges.
 *
 * The listed edges are the entries of `listed`, each one
 * `{ bundle: from, target: to }`. Items of `listed` whose `check` is not
 * `'cycles'` are ignored.
 *
 * @param {Snapshot} snapshot
 * @param {Entry[]} listed The violations file's entries of check `'cycles'`.
 * @returns {{ components: string[][], unknown: Entry[], unneeded: Entry[] }}
 * - `components`: the strongly connected components of more than one bundle
 *   in the graph without the listed edges.
 *   - Each component holds bundle ids in code-unit order.
 *   - The components are ordered by their first id.
 *   - It is `[]` when the listed edges break every cycle.
 * - `unknown`: listed entries that are not an edge of the graph, in `listed`
 *   order.
 * - `unneeded`: listed entries that are edges but break no cycle, in
 *   `listed` order.
 *   - An edge breaks no cycle when, in the graph without the other listed
 *     edges, its `target` cannot reach its `bundle`.
 *   - An entry that repeats the edge of an earlier entry is reported here.
 *
 * The test fails when any of the three is non-empty.
 */
export const findCycles = (snapshot, listed) => {
  const providers = providersOf(snapshot.bundles);
  const edges = new Set();
  const key = (from, to) => `${from}\0${to}`;

  for (const bundle of snapshot.bundles) {
    for (const field of ['requires', 'optional']) {
      for (const line of linesOf(bundle.manifest, field)) {
        const id = withoutVersion(line);
        for (const provider of providers.get(id) ?? []) {
          if (provider === bundle.id) continue;
          edges.add(
            declaredContracts[id] === bundle.id
              ? key(provider, bundle.id)
              : key(bundle.id, provider),
          );
        }
      }
    }
  }

  const entries = listed.filter((item) => item.check === 'cycles');
  const listedKeys = entries.map((item) => key(item.bundle, item.target));

  const adjacency = (removed) => {
    const next = new Map();
    for (const edge of edges) {
      if (removed.has(edge)) continue;
      const [from, to] = edge.split('\0');
      if (!next.has(from)) next.set(from, []);
      next.get(from).push(to);
    }
    return next;
  };

  const reaches = (graph, from, to) => {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === to) return true;
      for (const child of graph.get(node) ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          stack.push(child);
        }
      }
    }
    return false;
  };

  // Strongly connected components (Tarjan) of the graph without listed edges.
  const graph = adjacency(new Set(listedKeys));
  const nodes = [
    ...new Set([...edges].flatMap((edge) => edge.split('\0'))),
  ].sort();
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;

  const connect = (node) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);

    for (const child of graph.get(node) ?? []) {
      if (!index.has(child)) {
        connect(child);
        low.set(node, Math.min(low.get(node), low.get(child)));
      } else if (onStack.has(child)) {
        low.set(node, Math.min(low.get(node), index.get(child)));
      }
    }

    if (low.get(node) === index.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1) components.push(component.sort());
    }
  };

  for (const node of nodes) if (!index.has(node)) connect(node);
  components.sort((a, b) => compare(a[0], b[0]));

  const unknown = [];
  const unneeded = [];
  const earlier = new Set();

  entries.forEach((item, position) => {
    const edge = listedKeys[position];
    if (!edges.has(edge)) {
      unknown.push(item);
    } else if (earlier.has(edge)) {
      unneeded.push(item);
    } else {
      const others = new Set(
        listedKeys.filter((_, other) => other !== position),
      );
      if (!reaches(adjacency(others), item.target, item.bundle)) {
        unneeded.push(item);
      }
    }
    earlier.add(edge);
  });

  return { components, unknown, unneeded };
};

/**
 * Check `core` (`docs/designs/bundle-isolation.md` section 1, table row `core`; M6). Three assertions:
 *
 * 1. Each `desktopScope` key of the bundle `core` whose list holds
 *    `projectId`, `threadId` or `promptId`. There is one finding per contract
 *    and key:
 *    - `bundle` is `'core'`;
 *    - `target` is `<contract>:<key>`, for example `windows/v1:threadId`.
 * 2. A production import of a bundle's package from a platform package.
 *    - The files are those under `packages/<name>/src/` or
 *      `app/<group>/<name>/src/`.
 *    - Test files are excluded: a path with a segment `tests` or `__tests__`,
 *      or a file name that matches `/\.(test|spec)\.[cm]?[jt]sx?$/u`.
 *    - The match is a specifier, as `importedModules` reads it, that equals a
 *      bundle's `packageJson.name` or starts with it and `/`.
 *    - `bundle` is `snapshot.packageDirectories[<packages/<name> or
 *      app/<group>/<name>>]`, the name of the package that holds the file.
 *    - `target` is the specifier.
 * 3. The text `'/settings'`, with single quotes, in a file under
 *    `bundles/foundation/core/src/`. Comment lines count.
 *    - `bundle` is `'core'`;
 *    - `target` is the file's path.
 *
 * @param {Snapshot} snapshot
 * @returns {Finding[]}
 */
export const findCore = (snapshot) => {
  const found = collector('core');
  const core = snapshot.bundles.find((bundle) => bundle.id === 'core');
  const scope = core?.manifest?.desktopScope ?? {};

  for (const [contract, keys] of Object.entries(scope)) {
    for (const key of ['projectId', 'threadId', 'promptId']) {
      if (Array.isArray(keys) && keys.includes(key)) {
        found.add('core', `${contract}:${key}`);
      }
    }
  }

  const names = snapshot.bundles
    .map((bundle) => bundle.packageJson?.name)
    .filter((name) => typeof name === 'string');

  for (const file of snapshot.files) {
    const platform = /^(packages\/[^/]+|app\/[^/]+\/[^/]+)\/src\//u.exec(
      file.path,
    );
    if (platform) {
      const segments = file.path.split('/');
      const isTest =
        segments
          .slice(0, -1)
          .some((segment) => segment === 'tests' || segment === '__tests__') ||
        /\.(test|spec)\.[cm]?[jt]sx?$/u.test(segments.at(-1));

      if (!isTest) {
        const owner = snapshot.packageDirectories[platform[1]];
        for (const specifier of importedModules(file.source)) {
          if (names.some((name) => usesPackage(specifier, name))) {
            found.add(owner, specifier);
          }
        }
      }
    }

    if (
      file.path.startsWith('bundles/foundation/core/src/') &&
      file.source.includes("'/settings'")
    ) {
      found.add('core', file.path);
    }
  }

  return found.list();
};

/**
 * Check `lists` (`docs/designs/bundle-isolation.md` section 1, `lists`; M9).
 *
 * Build files: each file of `snapshot.buildFiles` is read line by line,
 * comments included. A line names a bundle when it matches either pattern:
 * - `/(?<![\w./-])bundles\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/u`
 * - `/"bundle-[a-z][a-z0-9-]*"/u`
 *
 * A file with one or more such lines gives one finding:
 * - `bundle` is `'doric-host'`;
 * - `target` is the file's path.
 *
 * Composition: the ids are those in `core`, `enabled`, `resident`,
 * `required.bundles`, the values of `providers`, and `default` and `options`
 * of each entry of `alternatives`. A missing field contributes no ids. An id
 * that matches no bundle in `snapshot.bundles` is a finding:
 * - `bundle` is `'doric-host'`;
 * - `target` is the id.
 * @param {Snapshot} snapshot
 * @returns {Finding[]}
 */
export const findLists = (snapshot) => {
  const found = collector('lists');
  const patterns = [
    /(?<![\w./-])bundles\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*/u,
    /"bundle-[a-z][a-z0-9-]*"/u,
  ];

  for (const file of snapshot.buildFiles) {
    if (
      file.source
        .split('\n')
        .some((line) => patterns.some((pattern) => pattern.test(line)))
    ) {
      found.add('doric-host', file.path);
    }
  }

  const composition = snapshot.composition ?? {};
  const asList = (value) => [value ?? []].flat();
  const ids = [
    ...asList(composition.core),
    ...asList(composition.enabled),
    ...asList(composition.resident),
    ...asList(composition.required?.bundles),
    ...Object.values(composition.providers ?? {}).flatMap(asList),
    ...Object.values(composition.alternatives ?? {}).flatMap((entry) => [
      ...asList(entry?.default),
      ...asList(entry?.options),
    ]),
  ];
  const known = new Set(snapshot.bundles.map((bundle) => bundle.id));

  for (const id of ids) if (!known.has(id)) found.add('doric-host', id);

  return found.list();
};

/**
 * Check `dependencies` (`docs/designs/bundle-isolation.md` section 1, `dependencies`; OD11).
 *
 * Every name under `dependencies` and `devDependencies` of each bundle's
 * `packageJson` is checked. The bundle's files are the files of
 * `snapshot.files` under `bundle.directory`.
 *
 * A package N is used when one of these holds:
 * 1. a file of the bundle has a specifier, as `importedModules` reads it,
 *    that equals N or starts with N and `/`;
 * 2. N is `tslib`;
 * 3. N is `react`, and the bundle has a `.tsx` or `.jsx` file;
 * 4. N is `@types/<m>`, and `<m>` is `node` or a package used by rule 1. In
 *    `<m>`, `a__b` stands for `@a/b`;
 * 5. `(bundle.id, N)` is a pair in `dependencyExceptions`.
 *
 * A listed package that is not used is a finding:
 * - `bundle` is the bundle id;
 * - `target` is N.
 *
 * A package listed under both keys gives at most one finding. Which key a
 * package is listed under is not checked.
 * @param {Snapshot} snapshot
 * @returns {Finding[]}
 */
export const findDependencies = (snapshot) => {
  const found = collector('dependencies');

  for (const bundle of snapshot.bundles) {
    const files = snapshot.files.filter((file) =>
      file.path.startsWith(`${bundle.directory}/`),
    );
    const specifiers = files.flatMap((file) => importedModules(file.source));
    const imported = (name) =>
      specifiers.some((specifier) => usesPackage(specifier, name));
    const hasJsx = files.some((file) => /\.[jt]sx$/u.test(file.path));
    const listed = new Set([
      ...Object.keys(bundle.packageJson?.dependencies ?? {}),
      ...Object.keys(bundle.packageJson?.devDependencies ?? {}),
    ]);

    for (const name of listed) {
      const typed = /^@types\/(.+)$/u.exec(name)?.[1];
      const typedPackage = typed?.includes('__')
        ? `@${typed.replace('__', '/')}`
        : typed;
      const used =
        imported(name) ||
        name === 'tslib' ||
        (name === 'react' && hasJsx) ||
        (typedPackage !== undefined &&
          (typedPackage === 'node' || imported(typedPackage))) ||
        dependencyExceptions.some(
          (pair) => pair.bundle === bundle.id && pair.package === name,
        );

      if (!used) found.add(bundle.id, name);
    }
  }

  return found.list();
};

/**
 * Compares the findings of the five non-cycle checks with the violations
 * file (`docs/designs/bundle-isolation.md` section 1, the bullet after the violations file). An entry
 * matches a finding when `check`, `bundle` and `target` are all equal.
 *
 * @param {{ findings: Finding[], entries: Entry[], exists: (path: string) => boolean }} input
 * - `findings`: findings of any of the five non-cycle checks.
 * - `entries`: the whole `violations` array.
 * - `exists`: tells whether a root-relative path is a file in the
 *   repository.
 * @returns {{ unlisted: Finding[], stale: Entry[], undocumented: Entry[] }}
 * - `unlisted`, in `findings` order:
 *   - the findings that no entry matches;
 *   - every finding for which `isSourcePathImport` holds, whether or not an
 *     entry matches it.
 * - `stale`, in `entries` order. Entries of check `cycles` are never stale
 *   here; `findCycles` judges them. An entry of any other check is stale
 *   when one of these holds:
 *   - it matches no finding;
 *   - `isSourcePathImport` holds for it;
 *   - it repeats the `(check, bundle, target)` of an earlier entry.
 * - `undocumented`, in `entries` order: the entries of every check, `cycles`
 *   included, for which `exists(decision)` is false.
 *
 * The test fails when any of the three is non-empty.
 *
 * Each entry is read once, `exists` is called once per entry, and the inputs
 * are not changed.
 */
export const diffViolations = ({ findings, entries, exists }) => {
  const key = (item) => `${item.check}\0${item.bundle}\0${item.target}`;
  const listedKeys = new Set(entries.map(key));
  const foundKeys = new Set(findings.map(key));

  const unlisted = findings.filter(
    (item) => isSourcePathImport(item) || !listedKeys.has(key(item)),
  );

  const stale = [];
  const undocumented = [];
  const earlier = new Set();

  for (const item of entries) {
    const itemKey = key(item);
    if (
      item.check !== 'cycles' &&
      (!foundKeys.has(itemKey) ||
        isSourcePathImport(item) ||
        earlier.has(itemKey))
    ) {
      stale.push(item);
    }
    earlier.add(itemKey);
    if (!exists(item.decision)) undocumented.push(item);
  }

  return { unlisted, stale, undocumented };
};
