import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import Mustache from 'mustache';

import {
  checkTemplate,
  loadTemplate,
  render,
  renderBlock,
  renderSection,
} from '../src/host/prompts/templates.js';

/** An error whose message names every given pattern. */
const naming =
  (...patterns: readonly RegExp[]) =>
  (error: unknown): boolean => {
    assert.ok(error instanceof Error);

    for (const pattern of patterns) {
      assert.match(error.message, pattern);
    }

    return true;
  };

const withDirectory = async (
  run: (directory: string) => Promise<void>,
): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'default-templates-'));

  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

void test('render does not HTML-escape interpolated values', () => {
  assert.equal(render('{{v}}', { v: '<b>&"' }), '<b>&"');
});

void test('render leaves the global mustache escaping untouched', () => {
  render('{{v}}', { v: '<b>&"' });

  assert.equal(Mustache.render('{{v}}', { v: '<' }), '&lt;');
});

void test('checkTemplate refuses a name the template does not declare, at any depth', () => {
  assert.throws(
    () => checkTemplate('Hi {{naoDeclarado}}', ['nome'], 'agent.md'),
    naming(/agent\.md/, /naoDeclarado/),
  );
  assert.throws(
    () =>
      checkTemplate('{{#nome}}{{naoDeclarado}}{{/nome}}', ['nome'], 'agent.md'),
    naming(/agent\.md/, /naoDeclarado/),
  );
});

void test('checkTemplate accepts declared sections, raw, inverted and comment tags unchanged', () => {
  const source =
    '{{#nome}}{{nome}}{{/nome}} {{{raw}}} {{^nome}}x{{/nome}}{{! note }}';

  assert.equal(checkTemplate(source, ['nome', 'raw'], 'ok.md'), source);
});

void test('checkTemplate refuses partials even when the name is declared', () => {
  assert.throws(
    () => checkTemplate('{{> parcial}}', ['parcial'], 'p.md'),
    naming(/p\.md/),
  );
});

void test('render leaves absent names empty and skips their sections', () => {
  assert.equal(render('a{{x}}b', {}), 'ab');
  assert.equal(render('{{#x}}line\n{{/x}}rest', {}), 'rest');
});

/** A list whose items are separated by a blank line, under a heading. */
const list = '# T\n{{#items}}\n\n- {{x}}\n{{/items}}';

void test('renderBlock renders the template without its final newline', () => {
  assert.equal(
    renderBlock(list, { items: [{ x: 'a' }, { x: 'b' }] }),
    '# T\n\n- a\n\n- b',
  );
});

void test('renderBlock removes only one trailing newline', () => {
  assert.equal(renderBlock('a\n\n', {}), 'a\n');
});

void test('renderSection renders one section with the given items, as a block', () => {
  assert.equal(
    renderSection(list, 'items', [{ x: 'a' }, { x: 'b' }]),
    '- a\n\n- b',
  );
});

void test('renderSection finds a section nested two levels deep', () => {
  const nested = '{{#outer}}\nO\n{{#inner}}\n| {{x}} |\n{{/inner}}\n{{/outer}}';

  assert.equal(
    renderSection(nested, 'inner', [{ x: 'a' }, { x: 'b' }]),
    '| a |\n| b |',
  );
});

void test('renderSection does not HTML-escape item values', () => {
  assert.equal(renderSection(list, 'items', [{ x: '<b>&"' }]), '- <b>&"');
  assert.equal(Mustache.render('{{v}}', { v: '<' }), '&lt;');
});

void test('renderSection gives an empty string for no items', () => {
  assert.equal(renderSection(list, 'items', []), '');
});

void test('renderSection refuses a section the template does not have', () => {
  assert.throws(
    () => renderSection(list, 'nope', [{ x: 'a' }]),
    naming(/no section "nope"/),
  );
});

void test('loadTemplate strips exactly one trailing newline', async () => {
  await withDirectory(async (directory) => {
    const single = join(directory, 'single.md');
    const double = join(directory, 'double.md');

    await writeFile(single, 'abc\n');
    await writeFile(double, 'abc\n\n');

    assert.equal(loadTemplate(pathToFileURL(single), []), 'abc');
    assert.equal(loadTemplate(pathToFileURL(double), []), 'abc\n');
  });
});

void test('loadTemplate fails with ENOENT for a missing file', async () => {
  await withDirectory(async (directory) => {
    const missing = pathToFileURL(join(directory, 'missing.md'));

    assert.throws(() => loadTemplate(missing, []), { code: 'ENOENT' });
  });
});
