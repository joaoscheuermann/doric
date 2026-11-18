/**
 * `ChoiceList` (`desktop/ui/choice-list`, O1 of step 6(c)) draws the rows of
 * one choice: each row is a button that commits its value on click, the
 * current row bears a check, a `note` sits beside its label, and `iconSlot`
 * gives every row a `ModelIcon` slot.
 *
 * Contract matrix:
 * - a click on a row commits that row's value, and only it;
 * - the current value's row, and no other, bears the check;
 * - `iconSlot` draws one `model-icon` slot per row, empty without an icon,
 *   and no slot without `iconSlot`;
 * - a row's `note` is drawn beside its label.
 *
 * The imports resolve through the package's export map, so this exercises
 * the files the windows load.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';

import type { ChoiceListProps } from 'desktop/ui/choice-list';
import { Window } from 'happy-dom';

const window = new Window();
const installed = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'HTMLButtonElement',
  'SVGElement',
  'DocumentFragment',
  'Element',
  'Node',
  'Event',
  'FocusEvent',
  'KeyboardEvent',
  'PointerEvent',
  'MouseEvent',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;

let ui: typeof import('desktop/ui/choice-list');
let createRoot: typeof import('react-dom/client').createRoot;
let createElement: typeof import('react').createElement;
let act: (callback: () => void | Promise<void>) => Promise<void>;

before(async () => {
  for (const name of installed) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: (window as unknown as Record<string, unknown>)[name],
      writable: true,
    });
  }
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const react = await import('react');
  act = react.act as typeof act;
  createElement = react.createElement;
  ({ createRoot } = await import('react-dom/client'));
  ui = await import('desktop/ui/choice-list');
});

after(async () => {
  await window.happyDOM.abort();
  await window.happyDOM.close();
});

const unmounts: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  document.body.replaceChildren();
});

const icon =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>';

const choices: ChoiceListProps['choices'] = [
  { label: 'GPT-5', value: 'openai/gpt-5', icon },
  { label: 'Claude', value: 'anthropic/claude', note: '(default)' },
  { label: 'Local', value: 'ollama/local' },
];

/** Mounts a list and answers its rows, in order. */
const mount = async (
  props: Partial<ChoiceListProps> = {},
): Promise<readonly HTMLButtonElement[]> => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(() => {
    root.render(
      createElement(ui.ChoiceList, {
        choices,
        onSelect: () => undefined,
        ...props,
      }),
    );
  });
  unmounts.push(() => act(() => root.unmount()));
  const rows = [...host.querySelectorAll('button')];
  assert.equal(rows.length, choices.length);
  return rows;
};

/** The visible text of a row, its icons aside. */
const text = (row: Element): string => (row.textContent ?? '').trim();

describe('ChoiceList', () => {
  test('draws one row per choice with its label', async () => {
    const rows = await mount();
    assert.deepEqual(
      rows.map((row) => text(row).replace('(default)', '').trim()),
      ['GPT-5', 'Claude', 'Local'],
    );
  });

  test("a click on a row commits that row's value, and only it", async () => {
    const selected: string[] = [];
    const rows = await mount({
      onSelect: (value: string) => selected.push(value),
    });
    await act(() => {
      rows[1]?.click();
    });
    assert.deepEqual(selected, ['anthropic/claude']);
  });

  test('the current row bears the check, and no other row does', async () => {
    const rows = await mount({ value: 'ollama/local' });
    assert.deepEqual(
      rows.map((row) => row.querySelector('svg') !== null),
      [false, false, true],
    );
  });

  test('with no current value no row bears the check', async () => {
    const rows = await mount();
    assert.ok(rows.every((row) => row.querySelector('svg') === null));
  });

  test('iconSlot draws a model-icon slot on every row, empty without an icon', async () => {
    const rows = await mount({ iconSlot: true });
    const slots = rows.map((row) =>
      row.querySelectorAll('[data-slot="model-icon"]'),
    );
    assert.deepEqual(
      slots.map((found) => found.length),
      [1, 1, 1],
    );
    assert.ok(slots[0]?.[0]?.getAttribute('style')?.includes('mask'));
    assert.equal(slots[1]?.[0]?.getAttribute('style'), null);
    assert.equal(slots[2]?.[0]?.getAttribute('style'), null);
  });

  test('without iconSlot no row draws a model-icon slot, even with an icon', async () => {
    const rows = await mount();
    assert.ok(
      rows.every(
        (row) => row.querySelector('[data-slot="model-icon"]') === null,
      ),
    );
  });

  test("a row's note is drawn beside its label", async () => {
    const rows = await mount();
    assert.match(text(rows[1] as Element), /Claude\s*\(default\)/u);
    assert.ok(!text(rows[0] as Element).includes('(default)'));
  });
});
