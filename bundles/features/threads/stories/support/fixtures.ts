// Delegated inputs and the records the threads stories read: a parent
// Thread that hands work to a child, and the child results it gets back, as
// the host records them once the envelope is removed.

import type { Thread } from 'runtime/contracts';

import { type RecordsSource, setRecords } from '../../src/client/source.js';

export const projectId = '6f1c2a9e-3b7d-4c55-9a0e-2d8b41f7c310';

/** A ready Thread record of the Project. */
const thread = (id: string, name: string): Thread => ({
  id,
  projectId,
  name,
  state: 'ready',
  lastSequence: 0,
  cwd: '/workspace',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

export const parentThread = thread(
  '0b6d7f42-91e3-4a8c-b2d5-7c1e9f03a6b4',
  'Ship the checkout redesign',
);

export const childThread = thread(
  'c3a85e10-4f27-4d6b-8e19-5b0f2a7d9c61',
  'Audit the payment form for accessibility',
);

export const longNamedThread = thread(
  '9e4b2c71-d8a0-4f3e-a615-03c7b9e2f854',
  'Migrate every settings screen from the legacy form library to the shared field components and remove the old validation helpers',
);

/** A Thread the records do not hold (deleted, or not loaded yet). */
export const unknownThreadId = 'f81d4fae-7dec-41d0-a765-00a0c91e6bf6';

const threads = new Map(
  [parentThread, childThread, longNamedThread].map((thread) => [
    thread.id,
    thread,
  ]),
);

const records: RecordsSource = {
  thread: (threadId) => threads.get(threadId),
  subscribe: () => ({ dispose: () => undefined }),
};

/** Seeds the records the sender's label and link are read from. */
export const seedWorkspace = (): void => {
  setRecords(records);
};

export const instructionText = [
  'Audit `src/components/checkout/PaymentForm.tsx` for accessibility.',
  '',
  '- Every input needs a visible label and an `aria-describedby` for its error.',
  '- The card number field must announce its formatting.',
  '- Run the axe checks in `tests/a11y/checkout.test.ts` and report what fails.',
  '',
  'Do not change the visual design; report anything that would need it.',
].join('\n');

export const resultText = [
  'The payment form now passes every axe check.',
  '',
  '1. Added labels to the expiry and CVC inputs (they only had placeholders).',
  '2. Linked each error message with `aria-describedby`.',
  '3. The card number field announces "4 groups of 4 digits".',
  '',
  'One open point: the "Pay now" button contrast is 4.1:1 in dark mode, below',
  'the 4.5:1 target. Fixing it needs a new token, so I left it for you.',
].join('\n');

export const failedResultText =
  'The axe run could not start: `npm run test:a11y` exited with code 1 because `jest-axe` is not installed in this workspace.';
