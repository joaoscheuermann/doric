import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import Parser from 'tree-sitter';

import { OkfError } from '../src/index.js';
import { detectType } from '../src/lib/detect.js';
import { parseInterface } from '../src/lib/interface.js';

const callerCannotForgeTrustedErrors = (): void => {
  // @ts-expect-error Error codes are package-owned, not caller-defined.
  new OkfError('CALLER_DEFINED', 'file.ts');

  // @ts-expect-error Construction is package-internal so callers cannot attach absolute sources.
  new OkfError('OKF_SUMMARY_FAILED', 'C:/private/repository/file.ts');
};

void callerCannotForgeTrustedErrors;

const tempRoot = async (context: TestContext): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'okf-interface-'));

  context.after(() => fs.rm(root, { recursive: true, force: true }));

  return root;
};

test('derives type from the lowercase final extension', () => {
  assert.equal(detectType('src/FILE.TSX'), 'tsx');

  assert.equal(detectType('archive.tar.GZ'), 'gz');

  assert.equal(detectType('README'), 'no-extension');

  assert.equal(detectType('.env'), 'no-extension');
});

test('extracts sorted TS imports exports aliases reexports and public members', async (context) => {
  const root = await tempRoot(context);

  await fs.mkdir(path.join(root, 'utils'));

  await Promise.all([
    fs.writeFile(path.join(root, 'dep.ts'), 'export const Thing = 1;', 'utf-8'),
    fs.writeFile(
      path.join(root, 'utils', 'index.ts'),
      'export const util = 1;',
      'utf-8',
    ),
  ]);

  const content = `
import Client, { Foo as Bar, type Shape } from './dep';
import * as Utils from './utils';
import { z } from 'zod';
import 'node:fs';
const missing = require('./missing');
void import('./dep');
export { Thing as Renamed } from './dep';
export * from './utils';
export interface Options { readonly value: string }
export type Alias = string;
export const VALUE: number = 1;
export function make(input: Options): Alias { return input.value; }
class Later { visible(): void {} private hidden(): void {} }
export { Later as PublicService };
export class Service {
  public field: string = '';
  private hidden = true;
  protected skip(): void {}
  constructor(readonly options: Options) {}
  get value(): string { return this.field; }
  set value(next: string) { this.field = next; }
  run(arg: string): number { return arg.length; }
}
`;

  const result = await parseInterface({
    root,
    source: 'main.ts',
    type: 'ts',
    content,
  });

  assert.deepEqual(result?.imports?.relative, [
    {
      source: './dep',
      target: 'dep.ts',
      symbols: [
        'Foo as Bar',
        'Thing as Renamed',
        'default as Client',
        'type Shape',
      ],
    },
    { source: './missing', target: null, symbols: ['default as missing'] },
    {
      source: './utils',
      target: 'utils/index.ts',
      symbols: ['*', '* as Utils'],
    },
  ]);

  assert.deepEqual(result?.imports?.external, [
    { source: 'node:fs', symbols: [] },
    { source: 'zod', symbols: ['z'] },
  ]);

  assert.deepEqual(result?.exports?.classes, ['PublicService', 'Service']);

  assert.deepEqual(result?.exports?.functions, ['make(input: Options): Alias']);

  assert.deepEqual(result?.exports?.variables, ['VALUE: number']);

  assert.deepEqual(result?.exports?.types, ['interface Options', 'type Alias']);

  assert.deepEqual(result?.exports?.reexports, ['*', 'Thing as Renamed']);

  assert.deepEqual(result?.exports?.methods, [
    'PublicService.visible(): void',
    'Service.constructor(readonly options: Options)',
    'Service.field: string',
    'Service.get value(): string',
    'Service.run(arg: string): number',
    'Service.set value(next: string)',
  ]);
});

test('extracts ESM JSX and CommonJS without non-literal calls', async (context) => {
  const root = await tempRoot(context);

  const content = `
const dependency = './ignored';
const helper = (value) => value;
const loaded = require('./literal');
require(dependency);
import(dependency);
exports.run = function (value) { return helper(value); };
exports.count = 1;
module.exports.extra = helper;
export const View = () => <section>OK</section>;
`;

  const result = await parseInterface({
    root,
    source: 'view.jsx',
    type: 'jsx',
    content,
  });

  assert.deepEqual(result?.imports?.relative, [
    { source: './literal', target: null, symbols: ['default as loaded'] },
  ]);

  assert.equal(result?.imports?.external, undefined);

  assert.deepEqual(result?.exports?.functions, ['run(value)']);

  assert.deepEqual(result?.exports?.variables, ['View', 'count', 'extra']);

  assert.equal(result?.exports?.classes, undefined);

  assert.equal(result?.exports?.types, undefined);
});

test('extracts abstract and ambient exported classes with public members', async (context) => {
  const root = await tempRoot(context);

  const content = `
export abstract class AbstractService {
  abstract run(value: string): number;
  public label: string;
  protected hidden: boolean;
}
export declare class AmbientService {
  value: string;
  get ready(): boolean;
  execute(count: number): void;
}
declare class HiddenService { visible(): void; }
`;

  const result = await parseInterface({
    root,
    source: 'services.ts',
    type: 'ts',
    content,
  });

  assert.deepEqual(result?.exports?.classes, [
    'AbstractService',
    'AmbientService',
  ]);

  assert.deepEqual(result?.exports?.methods, [
    'AbstractService.label: string',
    'AbstractService.run(value: string): number',
    'AmbientService.execute(count: number): void',
    'AmbientService.get ready(): boolean',
    'AmbientService.value: string',
  ]);
});

test('extracts TypeScript import equals export equals and type reexports', async (context) => {
  const root = await tempRoot(context);

  await Promise.all([
    fs.writeFile(path.join(root, 'foo.ts'), 'export class Foo {}', 'utf-8'),
    fs.writeFile(
      path.join(root, 'types.ts'),
      'export interface Shape {}',
      'utf-8',
    ),
  ]);

  const content = `
import Foo = require('./foo');
class Service { run(value: string): number { return value.length; } }
export = Service;
export type { Shape as Alias } from './types';
export { type Other } from './types';
`;

  const result = await parseInterface({
    root,
    source: 'entry.ts',
    type: 'ts',
    content,
  });

  assert.deepEqual(result?.imports?.relative, [
    {
      source: './foo',
      target: 'foo.ts',
      symbols: ['default as Foo'],
    },
    {
      source: './types',
      target: 'types.ts',
      symbols: ['type Other', 'type Shape as Alias'],
    },
  ]);

  assert.deepEqual(result?.exports?.classes, ['Service']);

  assert.deepEqual(result?.exports?.methods, [
    'Service.run(value: string): number',
  ]);

  assert.deepEqual(result?.exports?.reexports, [
    'type Other',
    'type Shape as Alias',
  ]);
});

test('extracts bracket and shorthand CommonJS exports canonically', async (context) => {
  const root = await tempRoot(context);

  const content = `
class Service { run(value) { return value; } }
function make(options) { return new Service(options); }
exports['factory'] = make;
module.exports['PublicService'] = Service;
module.exports = { Service, make, renamed: make };
`;

  const result = await parseInterface({
    root,
    source: 'common.cjs',
    type: 'cjs',
    content,
  });

  assert.deepEqual(result?.exports?.classes, ['PublicService', 'Service']);

  assert.deepEqual(result?.exports?.functions, [
    'factory(options)',
    'make(options)',
    'renamed(options)',
  ]);

  assert.deepEqual(result?.exports?.methods, [
    'PublicService.run(value)',
    'Service.run(value)',
  ]);
});

test('parses every supported grammar mapping and omits JSON interfaces', async (context) => {
  const root = await tempRoot(context);

  const cases = [
    ['file.ts', 'ts', 'export const value: number = 1;'],
    ['file.mts', 'mts', 'export const value: number = 1;'],
    ['file.cts', 'cts', 'export const value: number = 1;'],
    ['file.tsx', 'tsx', 'export const View = () => <main />;'],
    ['file.js', 'js', 'export const value = 1;'],
    ['file.mjs', 'mjs', 'export const value = 1;'],
    ['file.cjs', 'cjs', 'module.exports = { value: 1 };'],
    ['file.jsx', 'jsx', 'export const View = () => <main />;'],
    ['file.json', 'json', '{"value":1}'],
  ] as const;

  for (const [source, type, content] of cases) {
    const result = await parseInterface({ root, source, type, content });

    assert.equal(result === undefined, type === 'json', source);
  }
});

test('resolves exact files and circular imports while deduplicating symbols', async (context) => {
  const root = await tempRoot(context);

  await Promise.all([
    fs.writeFile(
      path.join(root, 'a.ts'),
      "import { b } from './b.ts';",
      'utf-8',
    ),
    fs.writeFile(path.join(root, 'b.ts'), "import { a } from './a';", 'utf-8'),
  ]);

  const a = await parseInterface({
    root,
    source: 'a.ts',
    type: 'ts',
    content: "import { b } from './b.ts'; import { b } from './b.ts';",
  });

  const b = await parseInterface({
    root,
    source: 'b.ts',
    type: 'ts',
    content: "import { a } from './a';",
  });

  assert.deepEqual(a?.imports?.relative, [
    { source: './b.ts', target: 'b.ts', symbols: ['b'] },
  ]);

  assert.deepEqual(b?.imports?.relative, [
    { source: './a', target: 'a.ts', symbols: ['a'] },
  ]);
});

test('rejects strict TS JavaScript and JSON syntax errors', async (context) => {
  const root = await tempRoot(context);

  const cases = [
    ['bad.ts', 'ts', 'export const = 1;'],
    ['bad.js', 'js', 'const = ;'],
    ['bad.json', 'json', '{]'],
  ] as const;

  for (const [source, type, content] of cases) {
    await assert.rejects(
      parseInterface({ root, source, type, content }),
      (error: unknown) => {
        assert.ok(error instanceof OkfError);

        assert.equal(error.code, 'OKF_SOURCE_SYNTAX_INVALID');

        assert.equal(error.stage, 'syntax');

        assert.equal(error.source, source);

        assert.equal(
          error.message,
          `Supported source syntax is invalid for ${source}.`,
        );

        assert.equal(error.hint, 'Fix the syntax error or exclude the file.');

        assert.equal(
          (error as Error & { readonly cause?: unknown }).cause,
          undefined,
        );

        return true;
      },
    );
  }
});

test('parses valid supported source larger than the default Tree-sitter buffer', async (context) => {
  const root = await tempRoot(context);
  const prefix = 'export const value = "';
  const suffix = '";';
  const content = `${prefix}${'a'.repeat(35_770 - prefix.length - suffix.length)}${suffix}`;

  const result = await parseInterface({
    root,
    source: 'large.ts',
    type: 'ts',
    content,
  });

  assert.deepEqual(result?.exports?.variables, ['value']);
});

test('sizes the Tree-sitter buffer from UTF-16 content length', async (context) => {
  const root = await tempRoot(context);
  const original = Parser.prototype.parse;
  const observed: number[] = [];

  context.mock.method(
    Parser.prototype,
    'parse',
    function (
      this: Parser,
      input: Parameters<Parser['parse']>[0],
      oldTree?: Parameters<Parser['parse']>[1],
      options?: Parameters<Parser['parse']>[2],
    ) {
      observed.push(options?.bufferSize ?? 0);

      return original.call(this, input, oldTree, options);
    },
  );

  const cases = [
    ['expanded.ts', 'a'.repeat(35_770), 65_536],
    ['boundary.ts', 'a'.repeat(32_768), 65_536],
    ['unicode.ts', '😀'.repeat(16_384), 65_536],
  ] as const;

  for (const [source, padding] of cases) {
    const content = `/*${padding.slice(4)}*/`;

    assert.equal(content.length, padding.length);

    await parseInterface({ root, source, type: 'ts', content });
  }

  assert.deepEqual(
    observed,
    cases.map(([, , bufferSize]) => bufferSize),
  );
});

test('reports native parse failures with curated details', async (context) => {
  const root = await tempRoot(context);
  const diagnostic = 'PRIVATE_NATIVE_PARSE_DIAGNOSTIC';

  context.mock.method(Parser.prototype, 'parse', () => {
    throw new Error(diagnostic);
  });

  await assert.rejects(
    parseInterface({
      root,
      source: 'large.ts',
      type: 'ts',
      content: 'export const value = 1;',
    }),
    (error: unknown) => {
      assert.ok(error instanceof OkfError);

      assert.equal(error.code, 'OKF_SOURCE_PARSE_FAILED');

      assert.equal(error.stage, 'parse');

      assert.equal(error.source, 'large.ts');

      assert.equal(error.message, 'Could not parse supported source large.ts.');

      assert.equal(
        error.hint,
        'Retry with a smaller file or more available memory.',
      );

      assert.equal(
        (error as Error & { readonly cause?: unknown }).cause,
        undefined,
      );

      assert.doesNotMatch(
        JSON.stringify({
          message: error.message,
          stack: error.stack,
          hint: error.hint,
        }),
        new RegExp(diagnostic, 'u'),
      );

      return true;
    },
  );
});
