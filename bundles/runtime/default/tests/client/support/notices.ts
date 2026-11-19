// Reading the failure notice a tool element draws (error-messages.md §3,
// §5.1), copied from the chat's client test support with the moved drawing
// (bundle isolation 5(b), as `files` has it): a
// `[data-slot="error-notice"]` whose title the notice names with
// `aria-labelledby`, whose explanation with `aria-describedby`, whose Retry is
// an icon button named by `aria-label`, and whose details open behind a
// "Details" button into a `<pre aria-label="Error details">`.

import assert from 'node:assert/strict';

import { settle } from './render.js';

/** Every failure notice inside `root`, in document order. */
const noticesIn = (root: ParentNode): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('[data-slot="error-notice"]'),
];

/** The text of the element `notice`'s attribute `name` points to. */
const labelledText = (
  notice: HTMLElement,
  name: 'aria-labelledby' | 'aria-describedby',
): string | undefined => {
  const id = notice.getAttribute(name);
  if (id === null) return undefined;
  return (
    notice.ownerDocument.getElementById(id)?.textContent?.trim() ?? undefined
  );
};

/** Opens the notice's details and answers the text they hold. */
const detailsOf = async (notice: HTMLElement): Promise<string> => {
  const trigger = [
    ...notice.querySelectorAll<HTMLButtonElement>('button'),
  ].find((button) => button.textContent?.trim() === 'Details');
  if (trigger !== undefined) {
    trigger.click();
    await settle();
  }
  return (
    notice.querySelector('pre[aria-label="Error details"]')?.textContent ?? ''
  );
};

/**
 * The notice a tool row draws inside `row` (§5.1): compact, not announced, no
 * Retry, titled by its first known level or `tool_failed`'s "Tool failed", and
 * naming the call in its details' `Tool:` line. A row the failure left folded
 * is opened through its header first.
 */
export const assertToolNotice = async (
  row: HTMLElement | null | undefined,
  expected: {
    readonly title: string;
    readonly explanation: string;
    readonly tool: string;
  },
): Promise<void> => {
  assert.ok(row, 'the tool row is drawn');
  if (noticesIn(row).length === 0) {
    row
      .querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')
      ?.click();
    await settle();
  }
  const notices = noticesIn(row);
  assert.equal(notices.length, 1, 'the row draws one failure notice');
  const notice = notices[0] as HTMLElement;
  assert.equal(notice.getAttribute('data-variant'), 'compact');
  assert.equal(notice.getAttribute('role'), 'group');
  assert.equal(labelledText(notice, 'aria-labelledby'), expected.title);
  assert.equal(labelledText(notice, 'aria-describedby'), expected.explanation);
  assert.equal(
    notice.querySelector('button[aria-label="Retry"]'),
    null,
    'a tool notice offers no Retry',
  );
  assert.match(
    await detailsOf(notice),
    new RegExp(`^Tool: ${expected.tool}$`, 'm'),
  );
};
