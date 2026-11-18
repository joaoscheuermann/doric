// Reading the failure notices a window draws (error-messages.md §3): each is a
// `[data-slot="error-notice"]` whose title the notice names with
// `aria-labelledby`, whose Retry and Copy details are icon buttons named by
// `aria-label`, and whose details open behind a "Details" button into a
// `<pre aria-label="Error details">`.

import assert from 'node:assert/strict';

import { settle } from './window.js';

/** Every failure notice inside `root`, in document order. */
export const noticesIn = (
  root: ParentNode | null | undefined,
): HTMLElement[] =>
  root === null || root === undefined
    ? []
    : [...root.querySelectorAll<HTMLElement>('[data-slot="error-notice"]')];

/** The notice's title, as the element its `aria-labelledby` names reads. */
export const titleOf = (notice: HTMLElement): string | undefined => {
  const id = notice.getAttribute('aria-labelledby');
  if (id === null) return undefined;
  return (
    notice.ownerDocument.getElementById(id)?.textContent?.trim() ?? undefined
  );
};

/** The notice's explanation, as the element its `aria-describedby` names reads. */
export const explanationOf = (notice: HTMLElement): string | undefined => {
  const id = notice.getAttribute('aria-describedby');
  if (id === null) return undefined;
  return (
    notice.ownerDocument.getElementById(id)?.textContent?.trim() ?? undefined
  );
};

/** The notices inside `root` whose title is `title`. */
export const noticesTitled = (
  root: ParentNode | null | undefined,
  title: string,
): HTMLElement[] =>
  noticesIn(root).filter((notice) => titleOf(notice) === title);

/** The notice's Retry button, when it offers one. */
export const retryOf = (notice: HTMLElement): HTMLButtonElement | null =>
  notice.querySelector<HTMLButtonElement>('button[aria-label="Retry"]');

/** Whether the notice announces itself (`announce`, §3.6). */
export const announced = (notice: HTMLElement): boolean =>
  notice.getAttribute('role') === 'alert';

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
    await settle(100);
  }
  const notices = noticesIn(row);
  assert.equal(notices.length, 1, 'the row draws one failure notice');
  const notice = notices[0] as HTMLElement;
  assert.equal(notice.getAttribute('data-variant'), 'compact');
  assert.equal(notice.getAttribute('role'), 'group');
  assert.equal(titleOf(notice), expected.title);
  assert.equal(explanationOf(notice), expected.explanation);
  assert.equal(retryOf(notice), null);
  assert.match(
    await detailsOf(notice),
    new RegExp(`^Tool: ${expected.tool}$`, 'm'),
  );
};

/** Opens the notice's details and answers the text they hold. */
export const detailsOf = async (notice: HTMLElement): Promise<string> => {
  const trigger = [
    ...notice.querySelectorAll<HTMLButtonElement>('button'),
  ].find((button) => button.textContent?.trim() === 'Details');
  if (trigger !== undefined) {
    trigger.click();
    await settle(50);
  }
  return (
    notice.querySelector('pre[aria-label="Error details"]')?.textContent ?? ''
  );
};
