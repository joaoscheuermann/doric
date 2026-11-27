// PC13 (D28): the texts of the retained library instruct, from `instructText`:
// ready (one line per component), `none` once after a root, `ignoredBy`'s
// line, 16,000 characters with the `Also:` line, a failed build and a
// failure without a root. The hooks that give them (the cwd event, the
// instruct, the binding by `turnSequence`, PC13 and PC14) are tested over the
// router in `router-hooks.test.ts` and `router-programs.test.ts` since the
// kernel entry left (S68c).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { instructText, MAX_INSTRUCT_CHARS } from '../src/host/library.js';
import type { LibraryComponent } from '../src/sandbox/protocol.js';

const APP = '/workspace/app';

const component = (name: string): LibraryComponent => ({
  name,
  description: `The ${name}.`,
  signature: `${name}(label: string)`,
  file: `.doric/papercraft/schemas/${name}.tsx`,
});

describe('PC13: instructText', () => {
  const ready = (
    root: string,
    components: readonly LibraryComponent[],
    ignoredBy?: string,
  ) =>
    [
      { root },
      {
        root,
        components,
        ...(ignoredBy === undefined ? {} : { ignoredBy }),
      },
    ] as const;

  test('a ready root: the count, then one line per component in order', () => {
    const [answer, entry] = ready(APP, [
      component('AppButton'),
      component('AppCard'),
    ]);

    const result = instructText(answer, entry, undefined);

    assert.equal(result?.root, APP);
    const lines = result?.text.split('\n') ?? [];
    assert.match(
      lines[0] ?? '',
      /^Repository library at \/workspace\/app: 2 components\.$/u,
    );
    assert.deepEqual(lines.slice(1), [
      'AppButton(label: string) — The AppButton.',
      'AppCard(label: string) — The AppCard.',
    ]);
  });

  test('an ignoredBy adds its line', () => {
    const [answer, entry] = ready(
      APP,
      [component('AppButton')],
      '.gitignore:9',
    );

    assert.ok(
      instructText(answer, entry, undefined)?.text.includes(
        "Git ignores these schema files (`.gitignore:9`), so they are not versioned. Tell the reader. Removing that rule keeps Doric's app state out of Git, because each Doric folder under `.doric/` has its own `.gitignore`.",
      ),
    );
  });

  test('a text past 16,000 characters ends with the Also: line and stays within the limit', () => {
    const components = Array.from({ length: 100 }, (_, index) => ({
      ...component(`Component${String(index).padStart(3, '0')}`),
      signature: `Component${String(index).padStart(3, '0')}(${'field: string, '.repeat(14)}last: string)`,
    }));
    for (const ignoredBy of [undefined, '.gitignore:9']) {
      const [answer, entry] = ready(APP, components, ignoredBy);

      const text = instructText(answer, entry, undefined)?.text ?? '';

      assert.equal(MAX_INSTRUCT_CHARS, 16_000);
      assert.ok(text.length <= 16_000, String(text.length));
      const lines = text.split('\n');
      const also = lines.find((line) => line.startsWith('Also: '));
      assert.ok(also, 'an Also: line');
      assert.match(also, /; read their schema files for their props\.$/u);
      const listed = lines
        .filter((line) => / — /u.test(line))
        .map((line) => line.slice(0, line.indexOf('(')));
      const rest = also
        .slice('Also: '.length, also.indexOf('; read their'))
        .split(', ');
      assert.deepEqual(
        [...listed, ...rest],
        components.map(({ name }) => name),
      );
      if (ignoredBy !== undefined) {
        assert.ok(text.includes(`(\`${ignoredBy}\`)`));
      }
    }
  });

  test('none: the text only after a root, with root null', () => {
    assert.deepEqual(instructText({ none: true }, undefined, APP), {
      root: null,
      text: 'No repository library here; use built-in components only.',
    });
    assert.equal(instructText({ none: true }, undefined, null), undefined);
    assert.equal(instructText({ none: true }, undefined, undefined), undefined);
    assert.equal(instructText(undefined, undefined, APP), undefined);
  });

  test('a failed root, and a failure without a root (a missing lease)', () => {
    assert.deepEqual(
      instructText({ root: APP }, { root: APP, error: 'boom' }, undefined),
      {
        root: APP,
        text: `The repository library at ${APP} did not compile: boom`,
      },
    );
    assert.deepEqual(
      instructText(
        {
          failed:
            "The Project's sandbox is not running; repository components need it",
        },
        undefined,
        undefined,
      ),
      {
        root: null,
        text: "The repository library could not be checked: The Project's sandbox is not running; repository components need it",
      },
    );
  });
});
