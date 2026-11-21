// The account menu, as `<account-status>` draws it alone (S26, T-2.2, T-2.15;
// bundle isolation 4(b), T4.7): the avatar named "Account" opens a menu naming
// the reader, then the entries of `account.menu`, then the app's name,
// license and version. An entry is a data item: its label after the icon
// element its tag names, and a pick executes its command with its input. An
// entry whose props are malformed is not drawn and is reported once. The
// badges of `account.status` sit in the avatar's corner, outside the button.
// On an app without `doric.about/v1` the footer names the license alone, and
// nothing fails.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { RegionsV1 } from 'bundle/contracts';
import { READER_NAME } from 'desktop/ui/identity';

import type { AccountFixture } from '../../stories/support/account-host.js';
import {
  type RenderedAccount,
  renderAccount,
  settle,
} from './support/render-account.js';

let rendered: RenderedAccount | undefined;

afterEach(() => {
  rendered?.cleanup();
  rendered = undefined;
  document.body.replaceChildren();
});

const normalized = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim();

/** The accessible name of a button: its `aria-label`, else its text. */
const nameOf = (element: Element): string =>
  normalized(element.getAttribute('aria-label') ?? element.textContent);

/** Presses `element` as a mouse does: pointer and mouse down, up, click. */
const press = async (element: HTMLElement): Promise<void> => {
  const init = {
    bubbles: true,
    cancelable: true,
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
  };
  element.dispatchEvent(new PointerEvent('pointerdown', init));
  element.dispatchEvent(new MouseEvent('mousedown', init));
  element.dispatchEvent(new PointerEvent('pointerup', init));
  element.dispatchEvent(new MouseEvent('mouseup', init));
  element.click();
  await settle();
};

/** The button named "Account" that `<account-status>` draws. */
const accountButton = (account: RenderedAccount): HTMLElement => {
  const buttons = [...account.root.querySelectorAll<HTMLElement>('button')];
  const found = buttons.find((button) => nameOf(button) === 'Account');
  assert.ok(
    found !== undefined,
    `No button named "Account" in <account-status>; buttons: ${buttons
      .map(nameOf)
      .join(' | ')}`,
  );
  return found;
};

/** Presses the "Account" button and answers the menu it opened. */
const openAccountMenu = async (
  account: RenderedAccount,
): Promise<HTMLElement> => {
  await press(accountButton(account));
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  assert.ok(menu !== null, 'Pressing "Account" opened no menu.');
  return menu;
};

/** Whether some element under `root` reads exactly `text`. */
const reads = (root: Element, text: string): boolean =>
  [...root.querySelectorAll('*')].some(
    (element) => normalized(element.textContent) === text,
  );

/** The first element under `root` that reads exactly `text`. */
const reading = (root: Element, text: string): Element => {
  const found = [...root.querySelectorAll('*')].find(
    (element) => normalized(element.textContent) === text,
  );
  assert.ok(
    found !== undefined,
    `Nothing reads "${text}": ${normalized(root.textContent)}`,
  );
  return found;
};

const menuItems = (menu: Element): HTMLElement[] => [
  ...menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
];

/** The text of `item` without the stand-ins of other bundles' elements. */
const labelOf = (item: Element): string => {
  const copy = item.cloneNode(true) as Element;
  for (const standIn of copy.querySelectorAll('[data-story-placeholder]'))
    standIn.remove();
  return normalized(copy.textContent);
};

/** Whether `later` comes after `earlier` in document order. */
const follows = (earlier: Node, later: Node): boolean =>
  (earlier.compareDocumentPosition(later) &
    Node.DOCUMENT_POSITION_FOLLOWING) !==
  0;

/** The made-up registrant's entry of rows 1 and 2. */
const probeEntry = {
  id: 'probe',
  tag: 'probe-icon',
  props: { label: 'Probe', command: 'probe.open/v1', input: { n: 1 } },
};

const withProbe: AccountFixture = {
  regions: { 'account.menu': [{ ...probeEntry, owner: 'probe' }] },
};

test('the account menu names the reader, the local account, the app and its version', async () => {
  rendered = await renderAccount();

  const menu = await openAccountMenu(rendered);

  for (const text of [
    READER_NAME,
    'Local account',
    'Doric',
    'MIT License · v0.0.1',
  ]) {
    assert.ok(
      reads(menu, text),
      `The menu does not read "${text}": ${normalized(menu.textContent)}`,
    );
  }
});

// T4.7: a data item of `account.menu` is drawn with its label and icon.
test('T4.7: an account.menu item is one menuitem reading its label after its icon element, between the header and the About line', async () => {
  rendered = await renderAccount(withProbe);

  const menu = await openAccountMenu(rendered);

  const items = menuItems(menu);
  assert.deepEqual(
    items.map(labelOf),
    ['Probe'],
    `The menu's entries: ${items.map((item) => normalized(item.textContent)).join(' | ')}`,
  );
  const [item] = items as [HTMLElement];
  const icon = item.querySelector('[data-story-placeholder="probe-icon"]');
  assert.ok(
    icon !== null,
    `The entry does not hold the element of probe-icon: ${item.innerHTML}`,
  );
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
  let label: Node | undefined;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!icon.contains(node) && normalized(node.textContent) === 'Probe') {
      label = node;
      break;
    }
  }
  assert.ok(label !== undefined, 'The entry holds no text "Probe".');
  assert.ok(follows(icon, label), 'The icon does not come before the label.');
  assert.ok(
    follows(reading(menu, 'Local account'), item),
    'The entry is not after the header.',
  );
  assert.ok(
    follows(item, reading(menu, 'Doric')),
    'The entry is not before the About line.',
  );
});

// T4.7: it executes its command with its input once per pick.
test('T4.7: picking an account.menu item executes its command with its input, once per pick', async () => {
  rendered = await renderAccount(withProbe);
  const pick = async (account: RenderedAccount): Promise<void> => {
    const menu = await openAccountMenu(account);
    const item = menuItems(menu).find((entry) => labelOf(entry) === 'Probe');
    assert.ok(item !== undefined, 'No "Probe" entry in the account menu.');
    await press(item);
  };

  await pick(rendered);
  assert.deepEqual(rendered.executed(), [
    { command: 'probe.open/v1', input: { n: 1 } },
  ]);

  await pick(rendered);
  assert.deepEqual(rendered.executed(), [
    { command: 'probe.open/v1', input: { n: 1 } },
    { command: 'probe.open/v1', input: { n: 1 } },
  ]);
});

// T4.7: an item with malformed `props` is not drawn (spec §8, decision O3).
test('T4.7: account.menu items with malformed props are not drawn, and each is reported once', async (t) => {
  const error = t.mock.method(console, 'error', () => undefined);
  rendered = await renderAccount({
    regions: {
      'account.menu': [
        {
          id: 'no-label',
          tag: 'probe-icon',
          owner: 'probe',
          props: { command: 'probe.open/v1' },
        },
        {
          id: 'bad-command',
          tag: 'probe-icon',
          owner: 'probe',
          props: { label: 'Bad command', command: 42 },
        },
        {
          id: 'bad-input',
          tag: 'probe-icon',
          owner: 'probe',
          props: { label: 'Bad input', command: 'probe.open/v1', input: [] },
        },
        {
          id: 'good',
          tag: 'probe-icon',
          owner: 'probe',
          props: { label: 'Good', command: 'probe.open/v1' },
        },
      ],
    },
  });
  // A further item changes the region, so the menu reads it again.
  rendered.services.use(RegionsV1).add('account.menu', {
    id: 'later',
    tag: 'probe-icon',
    props: { label: 'Later', command: 'probe.later/v1' },
  });
  await settle();

  const menu = await openAccountMenu(rendered);

  assert.deepEqual(menuItems(menu).map(labelOf), ['Good', 'Later']);
  const messages = error.mock.calls.map((call) => call.arguments[0]);
  assert.equal(
    messages.length,
    3,
    `console.error was called ${messages.length} times: ${messages.join(' | ')}`,
  );
  for (const message of messages) {
    assert.ok(
      typeof message === 'string' && message.startsWith('Doric:'),
      `A report does not start with "Doric:": ${String(message)}`,
    );
  }
});

// §7: the "Settings" entry is the `settings` bundle's item (decision O4); an
// empty `account.menu` leaves the header, one separator and the About line
// (decision O5).
test('with account.menu empty the menu holds the header and the About line, one separator and no entry', async () => {
  rendered = await renderAccount();

  const menu = await openAccountMenu(rendered);

  assert.deepEqual(
    menuItems(menu).map((item) => normalized(item.textContent)),
    [],
  );
  assert.ok(
    reads(menu, 'Local account'),
    `No header: ${normalized(menu.textContent)}`,
  );
  assert.ok(
    reads(menu, 'Doric'),
    `No About line: ${normalized(menu.textContent)}`,
  );
  assert.equal(menu.querySelectorAll('[role="separator"]').length, 1);
});

// §7 "What it draws": the badges of `account.status`, over the avatar.
test('an account.status item is drawn in <account-status>, outside the Account button', async () => {
  rendered = await renderAccount({
    regions: {
      'account.status': [{ id: 'badge', tag: 'probe-badge', owner: 'probe' }],
    },
  });

  const status = rendered.root.querySelector('[data-slot="account-status"]');
  assert.ok(status !== null, 'No [data-slot="account-status"] is drawn.');
  const badges = status.querySelectorAll(
    '[data-story-placeholder="probe-badge"]',
  );
  assert.equal(badges.length, 1, 'The badge is not drawn once.');
  assert.ok(
    !accountButton(rendered).contains(badges[0] ?? null),
    'The badge is inside the Account button.',
  );
});

test('without doric.about/v1 the footer names the license alone and nothing logs an error', async (t) => {
  const error = t.mock.method(console, 'error', () => undefined);
  rendered = await renderAccount({ absent: ['doric.about/v1'] });

  const menu = await openAccountMenu(rendered);

  assert.ok(
    reads(menu, 'Doric'),
    `The menu does not read "Doric": ${normalized(menu.textContent)}`,
  );
  assert.ok(
    reads(menu, 'MIT License'),
    `The menu does not read "MIT License" alone: ${normalized(menu.textContent)}`,
  );
  assert.ok(
    !normalized(menu.textContent).includes(' · v'),
    `The menu shows a version: ${normalized(menu.textContent)}`,
  );
  assert.deepEqual(
    error.mock.calls.map((call) => call.arguments),
    [],
  );
});

test('an account bound after one with the version shows none without doric.about/v1', async () => {
  rendered = await renderAccount();
  const first = await openAccountMenu(rendered);
  assert.ok(
    reads(first, 'MIT License · v0.0.1'),
    `The first menu shows no version: ${normalized(first.textContent)}`,
  );
  rendered.cleanup();

  rendered = await renderAccount({ absent: ['doric.about/v1'] });
  const menu = await openAccountMenu(rendered);

  assert.ok(
    reads(menu, 'MIT License'),
    `The menu does not read "MIT License" alone: ${normalized(menu.textContent)}`,
  );
});
