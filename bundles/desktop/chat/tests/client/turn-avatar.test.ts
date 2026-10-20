// The mark a turn wears in the conversation's gutter: `applyTurnAvatar` writes
// it into the turn block's own element, as the attributes and custom properties
// the block's `::before` reads. The mounted blocks are proven by
// `chat-view.test.ts`; this file proves the marks themselves.
//
// The marks need no more than a document, so the test opens a happy-dom window
// of its own, as `bundles/desktop/layout/tests/project-tabs-navigation.test.ts`
// does, instead of booting the built bundles `openChatWindow` loads.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { Window } from 'happy-dom';

import { applyTurnAvatar } from '../../src/client/components/organisms/conversation/nodes/turn-avatar.js';

const window = new Window();
const installed = ['window', 'document'] as const;
const previous = new Map<string, PropertyDescriptor | undefined>();

before(() => {
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of installed) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globals, name, {
      configurable: true,
      value: name === 'window' ? window : window.document,
    });
  }
});

after(async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const [name, descriptor] of previous) {
    if (descriptor === undefined) delete globals[name];
    else Object.defineProperty(globals, name, descriptor);
  }
  await window.happyDOM.close();
});

/** A turn block's element, before any mark is written into it. */
const block = (): HTMLElement =>
  window.document.createElement('div') as unknown as HTMLElement;

/** The value an element carries for a custom property, trimmed. */
const property = (element: HTMLElement, name: string): string =>
  element.style.getPropertyValue(name).trim();

describe('the mark a turn wears', () => {
  test('a reader wears the initials of their name and a tone of their own', () => {
    const element = block();

    applyTurnAvatar(element, { role: 'user', name: 'jao.scheuermann' });

    assert.equal(element.getAttribute('data-turn-avatar'), 'user');
    assert.equal(element.getAttribute('data-avatar-initials'), 'JS');
    assert.notEqual(property(element, '--turn-avatar-tone'), '');
    assert.notEqual(property(element, '--turn-avatar-ring'), '');
  });

  test('the agent wears its face, its rim and its glyph', () => {
    const element = block();

    applyTurnAvatar(element, { role: 'user', name: 'jao.scheuermann' });
    applyTurnAvatar(element, { role: 'agent', name: 'agent' });

    assert.equal(element.getAttribute('data-turn-avatar'), 'agent');
    assert.notEqual(property(element, '--turn-avatar-face'), '');
    assert.notEqual(property(element, '--turn-avatar-ring'), '');
    assert.notEqual(property(element, '--turn-avatar-mark'), '');
    assert.equal(element.hasAttribute('data-avatar-initials'), false);
  });

  test('a turn that wears no mark keeps none, and loses the one it wore', () => {
    const element = block();
    applyTurnAvatar(element, { role: 'user', name: 'jao.scheuermann' });

    applyTurnAvatar(element, null);

    assert.equal(element.hasAttribute('data-turn-avatar'), false);
    assert.equal(element.hasAttribute('data-avatar-initials'), false);
    assert.equal(property(element, '--turn-avatar-tone'), '');
    assert.equal(property(element, '--turn-avatar-face'), '');
    assert.equal(property(element, '--turn-avatar-ring'), '');
    assert.equal(property(element, '--turn-avatar-mark'), '');
  });
});
