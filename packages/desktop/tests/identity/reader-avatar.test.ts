// The reader's avatar beside their name (a comment, a prompt's author, the
// thread rail): the same square with 25% corners as the reader's gutter mark,
// never a circle. Rendered to markup on the server, as it needs no document.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ReaderAvatar } from 'desktop/ui/reader-avatar';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** The classes of the markup's outermost element. */
const classesOf = (markup: string): string[] =>
  (/^<[a-z]+[^>]*\sclass="([^"]*)"/.exec(markup)?.[1] ?? '').split(/\s+/);

test("the reader's avatar is a square with 25% corners", () => {
  const classes = classesOf(
    renderToStaticMarkup(
      createElement(ReaderAvatar, { name: 'jao.scheuermann' }),
    ),
  );

  assert.ok(classes.includes('rounded-[25%]'), classes.join(' '));
  assert.equal(classes.includes('rounded-full'), false);
});
