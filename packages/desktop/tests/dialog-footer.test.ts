/**
 * A dialog's footer sits on the dialog's own surface with no rule above it
 * (the redesign drops the footer's top border in both dialog kinds).
 *
 * The imports resolve through the package's export map, so this exercises the
 * artifact the windows load, not only the source it was built from.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AlertDialogFooter } from 'desktop/ui/alert-dialog';
import { DialogFooter } from 'desktop/ui/dialog';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** The class list of the first element in `markup`. */
const rootClasses = (markup: string): readonly string[] => {
  const found = /^<[^>]*class="([^"]*)"/u.exec(markup);
  assert.ok(found, `no class on the footer: ${markup}`);
  return (found[1] ?? '').split(/\s+/u);
};

describe('dialog footers', () => {
  test('a dialog footer draws no top border', () => {
    const classes = rootClasses(
      renderToStaticMarkup(createElement(DialogFooter, null, 'Done')),
    );
    assert.ok(!classes.includes('border-t'), classes.join(' '));
  });

  test('an alert dialog footer draws no top border', () => {
    const classes = rootClasses(
      renderToStaticMarkup(createElement(AlertDialogFooter, null, 'Done')),
    );
    assert.ok(!classes.includes('border-t'), classes.join(' '));
  });
});
