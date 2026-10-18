// The story data the presentational papercraft stories share: one
// `Checkout` preview of a Doric Project, its built markup and the pins and
// thread messages the canvas draws of it. Only types come from the
// contracts here, so a story of a part that reads no contract stays free of
// them.

import type { CommentPin } from '../../src/client/surface/pins-layer.js';
import type { ThreadMessage } from '../../src/client/surface/thread-popover.js';

export const PROJECT_ID = 'doric-web';
export const THREAD_ID = 'thread-checkout-redesign';
export const ARTIFACT_ID = 'checkout-7f3a';
export const SOURCE = 'src/components/Checkout.tsx';
export const TITLE = 'Checkout';

/** An ISO time `minutes` before now, so the relative times read naturally. */
export const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const stamp = (line: number) => `data-papercraft-source="${SOURCE}:${line}"`;

/** The built markup of one revision: a checkout card over the theme tokens. */
export const checkoutMarkup = (revision: number): string => `<!DOCTYPE html>
<html>
  <head>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; color: var(--foreground); }
      main { display: flex; justify-content: center; padding: 48px 24px; }
      .card { width: 360px; border: 1px solid var(--border); border-radius: 12px; background: var(--background); padding: 20px; display: grid; gap: 16px; }
      h1 { margin: 0; font-size: 18px; }
      .lead { margin: 0; color: var(--muted-foreground); font-size: 13px; }
      ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; font-size: 14px; }
      li { display: flex; justify-content: space-between; }
      .total { border-top: 1px solid var(--border); padding-top: 12px; font-weight: 600; }
      button { font: inherit; border: 0; border-radius: 8px; padding: 10px 14px; background: var(--primary); color: var(--primary-foreground); cursor: pointer; }
    </style>
  </head>
  <body ${stamp(1)}>
    <main ${stamp(8)}>
      <section class="card" ${stamp(10)}>
        <h1 ${stamp(12)}>Checkout</h1>
        <p class="lead" ${stamp(13)}>Review your order before paying.</p>
        <ul ${stamp(15)}>
          <li ${stamp(16)}><span>Doric Pro · annual</span><span>$96.00</span></li>
          <li ${stamp(17)}><span>Extra seat × 2</span><span>$48.00</span></li>
          <li class="total" ${stamp(18)}><span>Total</span><span>$144.00</span></li>
        </ul>
        <button id="pay" ${stamp(21)}>${revision > 1 ? 'Pay $144.00' : 'Pay now'}</button>
      </section>
    </main>
  </body>
</html>`;

/* What the presentational components take directly --------------------------- */

/** One pin per state, placed on a 720 × 480 canvas. */
export const PINS: readonly CommentPin[] = [
  {
    key: 'comment-pay-label',
    pin: 1,
    point: { x: 420, y: 330 },
    state: 'open',
    replies: 1,
    note: 'The pay button should say the total, not just "Pay now".',
  },
  {
    key: 'comment-seats',
    pin: 2,
    point: { x: 360, y: 220 },
    state: 'await',
    replies: 1,
    note: 'Should extra seats be monthly here, or annual like the plan?',
  },
  {
    key: 'comment-heading',
    pin: 3,
    point: { x: 260, y: 120 },
    state: 'done',
    replies: 0,
    note: 'Heading is too loud next to the lead text.',
  },
  {
    key: 'draft-total',
    pin: 4,
    point: { x: 470, y: 270 },
    state: 'draft',
    replies: 0,
    note: 'Bold the total amount, not the label.',
  },
  {
    key: 'comment-coupon',
    pin: 5,
    point: { x: 0, y: 28 },
    state: 'open',
    replies: 0,
    note: 'Where did the coupon field go?',
    detached: true,
  },
];

/** The messages of the open thread on the pay button. */
export const OPEN_THREAD: readonly ThreadMessage[] = [
  {
    id: 'comment-pay-label',
    text: 'The pay button should say the total, not just "Pay now".',
    createdAt: minutesAgo(32),
    draft: false,
  },
  {
    id: 'comment-pay-label-reply',
    text: 'Agreed, and keep it on one line at 360px.',
    createdAt: minutesAgo(30),
    draft: false,
  },
];

/** The thread on the seats row, where the agent spoke last. */
export const AWAITING_THREAD: readonly ThreadMessage[] = [
  {
    id: 'comment-seats',
    text: 'Should extra seats be monthly here, or annual like the plan?',
    createdAt: minutesAgo(25),
    draft: false,
  },
  {
    id: 'comment-seats-agent',
    author: 'agent',
    text: 'They bill with the plan, so annual. Do you want the per-month price shown next to it?',
    createdAt: minutesAgo(22),
    draft: false,
  },
];

/** A resolved thread. */
export const RESOLVED_THREAD: readonly ThreadMessage[] = [
  {
    id: 'comment-heading',
    text: 'Heading is too loud next to the lead text.',
    createdAt: minutesAgo(50),
    draft: false,
  },
  {
    id: 'comment-heading-agent',
    author: 'agent',
    text: 'Dropped the heading to 18px semibold and tightened the gap.',
    createdAt: minutesAgo(44),
    draft: false,
  },
];

/** A thread whose root is still a draft in the stack. */
export const DRAFT_THREAD: readonly ThreadMessage[] = [
  {
    id: 'draft-total',
    text: 'Bold the total amount, not the label.',
    draft: true,
  },
];
