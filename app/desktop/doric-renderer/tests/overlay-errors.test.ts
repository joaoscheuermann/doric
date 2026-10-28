/**
 * The dev overlay's filter for the window's runtime errors, run as the page
 * runs it: the dev server sends its source text, and the client rebuilds it
 * with `new Function`, so it has to work with nothing from outside itself.
 *
 * - an error of the app shows, its cause from the app too;
 * - a ResizeObserver loop notice does not;
 * - an error whose cause chain reaches an artifact preview's module does not
 *   (React's #520 around a preview's render error).
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

const renderer = join(__dirname, '../..');
const { showsInOverlay } = require(join(renderer, 'overlay-errors.js')) as {
  showsInOverlay: (error: unknown) => boolean;
};

/** The filter as the dev server's client rebuilds it from its source. */
const asThePageRunsIt = new Function(
  'message',
  `var callback = ${showsInOverlay.toString()}\nreturn callback(message)`,
) as (error: unknown) => boolean;

const raised = (message: string, at: string, cause?: unknown): Error => {
  const error = Object.assign(new Error(message), { cause });
  error.stack = `Error: ${message}\n    at render (${at})`;
  return error;
};

const reactRecovered = (cause: unknown): Error =>
  raised(
    'Minified React error #520',
    'doric://app/platform/react-dom@19.2.8/client.js:8:66465',
    cause,
  );

test("the app's own errors show", () => {
  assert.equal(
    asThePageRunsIt(
      raised(
        'React is not defined',
        'doric://app/bundles/mcp@1.0.0/client/index.js:979:5',
      ),
    ),
    true,
  );
  assert.equal(
    asThePageRunsIt(
      reactRecovered(
        raised('boom', 'doric://app/bundles/layout@1.0.0/client/index.js:12:3'),
      ),
    ),
    true,
  );
});

test('a ResizeObserver loop notice does not show', () => {
  assert.equal(
    asThePageRunsIt(
      new Error(
        'ResizeObserver loop completed with undelivered notifications.',
      ),
    ),
    false,
  );
});

test("an artifact preview's error does not show, however deep its cause", () => {
  const preview = raised(
    "Failed to execute 'define' on 'CustomElementRegistry'",
    'doric://app/artifacts/mcp-painel-lateral-todos-os-status-9609@3/index.js:20894:18',
  );

  assert.equal(asThePageRunsIt(preview), false);
  assert.equal(asThePageRunsIt(reactRecovered(preview)), false);
});
