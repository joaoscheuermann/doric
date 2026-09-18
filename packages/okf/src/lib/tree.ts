import { parseDocument } from 'yaml';

export type TreeEntry = {
  readonly path: string;
  readonly description: string;
};

type Tree = Map<string, Tree | TreeEntry>;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

/** Maps source paths without colliding with reserved OKF index or log files. */
export const outputPath = (source: string): string => {
  const name = pathName(source);

  return /^(?:index|log)(?:\.md)*$/iu.test(name)
    ? `${source}.md.md`
    : `${source}.md`;
};

const pathName = (source: string): string => {
  const separator = Math.max(source.lastIndexOf('/'), source.lastIndexOf('\\'));

  return source.slice(separator + 1);
};

/** Extracts the description from parsed generated OKF YAML frontmatter. */
export const parseDescription = (markdown: string): string => {
  const frontmatter = FRONTMATTER.exec(markdown)?.[1] ?? '';
  const document = parseDocument(frontmatter, { uniqueKeys: true });

  if (document.errors.length > 0) {
    throw new Error('Generated OKF frontmatter must be valid YAML');
  }

  const description = document.get('description');

  if (description === undefined) {
    throw new Error('Generated OKF frontmatter is missing description');
  }

  if (typeof description !== 'string') {
    throw new Error('Generated OKF frontmatter description must be a string');
  }

  return description;
};

/** Renders source entries as a deterministic Markdown tree linking mirrored outputs. */
export const renderTree = (entries: readonly TreeEntry[]): string => {
  const tree: Tree = new Map();

  const unique = entries
    .map((entry) => ({
      ...entry,
      description: entry.description.replace(/\s+/gu, ' ').trim(),
    }))
    .sort(
      (left, right) =>
        compare(left.path, right.path) ||
        compare(left.description, right.description),
    )
    .filter(
      (entry, index, sorted) =>
        index === 0 || entry.path !== sorted[index - 1]?.path,
    );

  for (const entry of unique) {
    add(tree, entry);
  }

  return ['# Project', '', ...render(tree)].join('\n') + '\n';
};

const add = (tree: Tree, entry: TreeEntry): void => {
  const parts = entry.path.split('/');
  let node = tree;

  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1) {
      node.set(part, entry);

      return;
    }

    const current = node.get(part);

    if (current instanceof Map) {
      node = current;

      continue;
    }

    const child: Tree = new Map();

    node.set(part, child);

    node = child;
  }
};

const render = (tree: Tree, level = 0): readonly string[] =>
  [...tree.entries()]
    .sort(([left], [right]) => compare(left, right))
    .flatMap(([name, value]) =>
      value instanceof Map
        ? [
            `${'  '.repeat(level)}- ${label(name)}/`,
            ...render(value, level + 1),
          ]
        : [
            `${'  '.repeat(level)}- [${label(value.path)}](${link(value.path)}) - ${value.description}`,
          ],
    );

const link = (source: string): string =>
  outputPath(source).split('/').map(encode).join('/');

const encode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const label = (value: string): string =>
  value.replace(/[\\[\]\x60*_<>&~]/gu, '\\$&');

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
