import Parser from 'tree-sitter';
import JavaScript from 'tree-sitter-javascript';
import Json from 'tree-sitter-json';
import TypeScript from 'tree-sitter-typescript';

import { createOkfError } from './classes/okf-error.js';
import {
  hasModuleInterface,
  isTypeScript,
  type SupportedType,
} from './detect.js';
import { extractExports } from './exports.js';
import { extractImports } from './imports.js';
import { resolveImports } from './resolve.js';
import type { ModuleInterface } from './types/interface.js';

export const PARSER_DEPENDENCY_VERSIONS = {
  'tree-sitter': '0.21.1',
  'tree-sitter-javascript': '0.23.1',
  'tree-sitter-typescript': '0.23.2',
  'tree-sitter-json': '0.24.8',
} as const;

export const PARSER_VERSION = Object.entries(PARSER_DEPENDENCY_VERSIONS)
  .map(([name, version]) => `${name}@${version}`)
  .join('|')
  .concat('|buffer-next-power-of-two-v1');
export const EXTRACTOR_VERSION = 'module-interface-v2';

const INTERFACE_QUERY = `
[
  (import_statement)
  (export_statement)
  (call_expression)
  (assignment_expression)
] @item
`;

type ParseInput = {
  readonly content: string;
  readonly root: string;
  readonly source: string;
  readonly type: SupportedType;
};

/** Strictly parses supported files and extracts TS/JS module relationships. */
export const parseInterface = async (
  input: ParseInput,
): Promise<ModuleInterface | undefined> => {
  const language = selectLanguage(input.type);

  const tree = (() => {
    try {
      const required = input.content.length + 1;
      const baseline = Math.max(32_768, required);
      const bufferSize = 2 ** Math.ceil(Math.log2(baseline));

      if (
        !Number.isSafeInteger(required) ||
        !Number.isFinite(required) ||
        !Number.isSafeInteger(bufferSize) ||
        !Number.isFinite(bufferSize) ||
        bufferSize > 0xffffffff
      ) {
        throw new Error('Invalid Tree-sitter buffer size.');
      }

      const parser = new Parser();

      parser.setLanguage(language);

      return parser.parse(input.content, undefined, { bufferSize });
    } catch {
      throw createOkfError('OKF_SOURCE_PARSE_FAILED', input.source);
    }
  })();

  if (tree.rootNode.hasError) {
    throw createOkfError('OKF_SOURCE_SYNTAX_INVALID', input.source);
  }

  if (!hasModuleInterface(input.type)) {
    return undefined;
  }

  const query = new Parser.Query(language, INTERFACE_QUERY);
  const nodes = query.captures(tree.rootNode).map(({ node }) => node);
  const rawImports = extractImports(nodes);
  const exports = extractExports(tree.rootNode, nodes, rawImports);
  const imports = await resolveImports(input, rawImports);

  return {
    ...(imports === undefined ? {} : { imports }),
    ...(exports === undefined ? {} : { exports }),
  };
};

const selectLanguage = (type: SupportedType): unknown => {
  if (type === 'json') {
    return Json;
  }

  if (type === 'tsx') {
    return TypeScript.tsx;
  }

  if (isTypeScript(type)) {
    return TypeScript.typescript;
  }

  return JavaScript;
};
