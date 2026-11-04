// The mark a turn wears in the conversation's gutter: `applyTurnAvatar` writes
// it into the turn block's own element, as the attributes and custom properties
// the block's pseudo-elements read. The mounted blocks are proven by
// `chat-view.test.ts`; this file proves the marks themselves.
//
// The marks need no more than a document, so the test opens a happy-dom window
// of its own, as `bundles/desktop/layout/tests/project-tabs-navigation.test.ts`
// does, instead of booting the built bundles `openChatWindow` loads.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { svgMask } from 'desktop/ui/svg-mask';
import { Window } from 'happy-dom';

import {
  type AgentMarkIcon,
  applyTurnAvatar,
  sameTurnAvatar,
  type TurnAvatar,
} from '../../src/client/components/organisms/conversation/nodes/turn-avatar.js';

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

/** A model's icon, as the host answers it. */
const MODEL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';

/** Another model's icon. */
const OTHER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="20" height="20" x="2" y="2"/></svg>';

/** The icon mask an agent mark in the given state wears, read off a scratch block. */
const iconOf = (icon: AgentMarkIcon): string => {
  const element = block();
  applyTurnAvatar(element, { role: 'agent', name: 'agent', icon });
  return property(element, '--turn-avatar-icon');
};

describe('the mark a turn wears', () => {
  test('a reader wears the initials of their name and a tone of their own', () => {
    const element = block();

    applyTurnAvatar(element, { role: 'user', name: 'jao.scheuermann' });

    assert.equal(element.getAttribute('data-turn-avatar'), 'user');
    assert.equal(element.getAttribute('data-avatar-initials'), 'JS');
    assert.notEqual(property(element, '--turn-avatar-tone'), '');
    assert.notEqual(property(element, '--turn-avatar-ring'), '');
  });

  test("an agent wears its model's icon as a mask and no face, rim or glyph", () => {
    const element = block();

    applyTurnAvatar(element, { role: 'user', name: 'jao.scheuermann' });
    applyTurnAvatar(element, {
      role: 'agent',
      name: 'agent',
      icon: { kind: 'icon', svg: MODEL_SVG },
    });

    assert.equal(element.getAttribute('data-turn-avatar'), 'agent');
    assert.equal(property(element, '--turn-avatar-icon'), svgMask(MODEL_SVG));
    assert.equal(property(element, '--turn-avatar-face'), '');
    assert.equal(property(element, '--turn-avatar-ring'), '');
    assert.equal(property(element, '--turn-avatar-mark'), '');
    assert.equal(property(element, '--turn-avatar-tone'), '');
    assert.equal(element.hasAttribute('data-avatar-initials'), false);
  });

  test('the fallback wears the bot glyph, and pending a mask that is not the glyph', () => {
    const glyph = iconOf({ kind: 'fallback' });
    const empty = iconOf({ kind: 'pending' });

    assert.match(glyph, /^url\("data:image\/svg\+xml,/);
    assert.match(empty, /^url\("data:image\/svg\+xml,/);
    assert.notEqual(empty, glyph);
    assert.notEqual(glyph, svgMask(MODEL_SVG));
  });

  test('two agent marks with different icons are not the same mark', () => {
    const agent = (icon: AgentMarkIcon): TurnAvatar => ({
      role: 'agent',
      name: 'agent',
      icon,
    });

    assert.equal(
      sameTurnAvatar(
        agent({ kind: 'icon', svg: MODEL_SVG }),
        agent({ kind: 'icon', svg: MODEL_SVG }),
      ),
      true,
    );
    assert.equal(
      sameTurnAvatar(
        agent({ kind: 'icon', svg: MODEL_SVG }),
        agent({ kind: 'icon', svg: OTHER_SVG }),
      ),
      false,
    );
    assert.equal(
      sameTurnAvatar(agent({ kind: 'pending' }), agent({ kind: 'fallback' })),
      false,
    );
    assert.equal(
      sameTurnAvatar(
        agent({ kind: 'pending' }),
        agent({ kind: 'icon', svg: MODEL_SVG }),
      ),
      false,
    );
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
    assert.equal(property(element, '--turn-avatar-icon'), '');
  });

  test("a reader's mark loses the icon an agent mark left", () => {
    const element = block();
    applyTurnAvatar(element, {
      role: 'agent',
      name: 'agent',
      icon: { kind: 'icon', svg: MODEL_SVG },
    });

    applyTurnAvatar(element, { role: 'user', name: 'jao.scheuermann' });

    assert.equal(element.getAttribute('data-turn-avatar'), 'user');
    assert.equal(property(element, '--turn-avatar-icon'), '');
  });
});
