import path from 'node:path';

import { Document, isSeq, parseDocument } from 'yaml';

import type { Summary } from './summarize.js';
import type { ModuleInterface } from './types/interface.js';

type ConceptInput = Summary & {
  readonly hash: string;
  readonly interface?: ModuleInterface;
  readonly source: string;
  readonly timestamp: string;
  readonly type: string;
};

/** Renders one deterministic YAML-frontmatter concept and Markdown analysis. */
export const renderConcept = (input: ConceptInput): string => {
  const metadata = {
    id: input.source,
    title: title(input.source),
    type: input.type,
    description: input.description,
    resource: `source:${input.source}`,
    tags: input.tags,
    timestamp: input.timestamp,
    hash: input.hash,
    ...(input.interface?.imports === undefined
      ? {}
      : { imports: input.interface.imports }),
    ...(input.interface?.exports === undefined
      ? {}
      : { exports: input.interface.exports }),
  };
  const document = new Document(metadata);

  markFlowSequences(document, metadata);

  const yaml = document.toString({
    defaultKeyType: 'PLAIN',
    defaultStringType: 'QUOTE_DOUBLE',
    lineWidth: 0,
  });

  return `---\n${yaml}---\n\n${input.analysis.trim()}\n`;
};

/** Parses YAML frontmatter and compares its hash as an exact scalar value. */
export const hasRecipeHash = (markdown: string, expected: string): boolean => {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(
    markdown,
  )?.[1];

  if (frontmatter === undefined) {
    return false;
  }

  const document = parseDocument(frontmatter, { uniqueKeys: true });

  if (document.errors.length > 0) {
    return false;
  }

  return document.get('hash') === expected;
};

const title = (source: string): string => {
  const name = path.posix.basename(source);
  const extension = path.posix.extname(name);

  return extension.length === 0 ? name : name.slice(0, -extension.length);
};

const markFlowSequences = (document: Document, metadata: object): void => {
  const walk = (
    value: unknown,
    location: readonly (string | number)[],
  ): void => {
    if (Array.isArray(value)) {
      const node = document.getIn(location, true);

      if (isSeq(node) && value.every((item) => typeof item === 'string')) {
        node.flow = true;
      }

      value.forEach((item, index) => walk(item, [...location, index]));

      return;
    }

    if (value === null || typeof value !== 'object') {
      return;
    }

    Object.entries(value).forEach(([key, item]) =>
      walk(item, [...location, key]),
    );
  };

  walk(metadata, []);
};
