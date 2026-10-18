// The sandbox the files stories show: the Project "Checkout redesign", its
// Thread working in `/workspace`, the workspace tree the host lists, the text
// of a few of its files, and the marks git's changes read gives the tree.

import type { Project, Thread } from 'runtime/contracts';

import type { ChangeMark } from '../../src/client/api/peers.js';
import type { ProjectFileContent } from '../../src/client/reads/project-files.js';
import type { ProjectTreeNode } from '../../src/contracts/index.js';

export const project: Project = {
  id: 'prj_checkout',
  name: 'Checkout redesign',
  color: 'blue',
  state: 'ready',
  configRevision: 4,
  createdAt: '2026-10-12T09:14:00.000Z',
  updatedAt: '2026-10-16T08:02:00.000Z',
  startedAt: '2026-10-12T09:14:05.000Z',
};

export const thread: Thread = {
  id: 'thr_payment_form',
  projectId: project.id,
  name: 'Split the payment form into steps',
  state: 'ready',
  lastSequence: 182,
  cwd: '/workspace',
  cwdRepo: 'github',
  createdAt: '2026-10-15T14:20:00.000Z',
  updatedAt: '2026-10-16T08:02:00.000Z',
};

/** A Thread working inside one package of the workspace. */
export const nestedThread: Thread = {
  ...thread,
  id: 'thr_web_tests',
  name: 'Cover the web checkout with tests',
  cwd: '/workspace/apps/web',
};

const file = (path: string, size: number): ProjectTreeNode => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  type: 'file',
  size,
});

const directory = (
  path: string,
  children: readonly ProjectTreeNode[],
): ProjectTreeNode => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  type: 'directory',
  children,
});

export const workspaceTree: readonly ProjectTreeNode[] = [
  directory('.github', [
    directory('.github/workflows', [file('.github/workflows/ci.yml', 1184)]),
  ]),
  directory('apps', [
    directory('apps/web', [
      directory('apps/web/src', [
        directory('apps/web/src/checkout', [
          file('apps/web/src/checkout/checkout.tsx', 4210),
          file('apps/web/src/checkout/payment-form.tsx', 3876),
          file('apps/web/src/checkout/shipping-step.tsx', 2290),
          file('apps/web/src/checkout/use-cart.ts', 1402),
        ]),
        file('apps/web/src/main.tsx', 388),
        file('apps/web/src/styles.css', 2051),
      ]),
      file('apps/web/package.json', 912),
      file('apps/web/vite.config.ts', 341),
    ]),
  ]),
  directory('packages', [
    directory('packages/pricing', [
      directory('packages/pricing/src', [
        file('packages/pricing/src/index.ts', 120),
        file('packages/pricing/src/totals.ts', 1876),
      ]),
      file('packages/pricing/package.json', 644),
    ]),
  ]),
  directory('docs', []),
  file('.gitignore', 96),
  file('README.md', 1630),
  file('package.json', 1022),
  file('tsconfig.json', 488),
];

/** The directories the reader opened in the stories that show them open. */
export const openDirectories: ReadonlySet<string> = new Set([
  'apps',
  'apps/web',
  'apps/web/src',
  'apps/web/src/checkout',
  'packages',
]);

/** The tree a Thread rooted at `apps/web` lists. */
export const webTree: readonly ProjectTreeNode[] =
  workspaceTree[1]?.children?.[0]?.children ?? [];

/** A workspace with one directory of many generated files. */
export const largeTree: readonly ProjectTreeNode[] = [
  directory(
    'fixtures',
    Array.from({ length: 60 }, (_, index) =>
      file(
        `fixtures/order-${String(index + 1).padStart(3, '0')}-with-a-long-descriptive-name.json`,
        2048 + index * 17,
      ),
    ),
  ),
  ...workspaceTree,
];

const tone = {
  added: 'text-[var(--git-added)]',
  modified: 'text-[var(--git-modified)]',
  deleted: 'text-[var(--git-deleted)]',
};

/** git's marks for the change set of the payment form Thread. */
export const changeMarks: ReadonlyMap<string, ChangeMark> = new Map([
  [
    'apps',
    {
      description: '3 changed files',
      count: 3,
      tone: tone.modified,
    },
  ],
  [
    'apps/web',
    {
      description: '3 changed files',
      count: 3,
      tone: tone.modified,
    },
  ],
  [
    'apps/web/src',
    {
      description: '3 changed files',
      count: 3,
      tone: tone.modified,
    },
  ],
  [
    'apps/web/src/checkout',
    {
      description: '3 changed files',
      count: 3,
      tone: tone.modified,
    },
  ],
  [
    'apps/web/src/checkout/payment-form.tsx',
    {
      description: 'Modified',
      count: 1,
      tone: tone.modified,
      letter: 'M',
    },
  ],
  [
    'apps/web/src/checkout/shipping-step.tsx',
    {
      description: 'Added',
      count: 1,
      tone: tone.added,
      letter: 'A',
    },
  ],
  [
    'apps/web/src/checkout/use-cart.ts',
    {
      description: 'Deleted',
      count: 1,
      tone: tone.deleted,
      letter: 'D',
      struck: true,
    },
  ],
]);

export const paymentForm: ProjectFileContent = {
  path: 'apps/web/src/checkout/payment-form.tsx',
  truncated: false,
  binary: false,
  content: `import { useState } from 'react';

import { formatTotal } from '@checkout/pricing';

import { ShippingStep } from './shipping-step';
import { useCart } from './use-cart';

type Step = 'shipping' | 'payment' | 'review';

export function PaymentForm({ onSubmit }: { onSubmit: () => Promise<void> }) {
  const cart = useCart();
  const [step, setStep] = useState<Step>('shipping');
  const [submitting, setSubmitting] = useState(false);

  if (step === 'shipping') {
    return <ShippingStep onNext={() => setStep('payment')} />;
  }

  return (
    <form
      className="payment-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setSubmitting(true);
        try {
          await onSubmit();
          setStep('review');
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <label htmlFor="card-number">Card number</label>
      <input id="card-number" autoComplete="cc-number" inputMode="numeric" />
      <button type="submit" disabled={submitting}>
        Pay {formatTotal(cart.total, cart.currency)}
      </button>
    </form>
  );
}
`,
};

export const readme: ProjectFileContent = {
  path: 'README.md',
  truncated: false,
  binary: false,
  content: `# Checkout redesign

The web checkout, split into shipping, payment and review steps.

## Development

\`\`\`sh
npm install
npm run dev --workspace apps/web
\`\`\`

## Packages

- \`apps/web\` — the checkout UI (React + Vite).
- \`packages/pricing\` — totals, taxes and currency formatting.
`,
};

export const lockfile: ProjectFileContent = {
  path: 'package-lock.json',
  truncated: true,
  binary: false,
  content: `{
  "name": "checkout-redesign",
  "version": "0.4.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "checkout-redesign",
      "version": "0.4.0",
      "workspaces": ["apps/*", "packages/*"]
    },
    "node_modules/@babel/code-frame": {
      "version": "7.27.1",
      "resolved": "https://registry.npmjs.org/@babel/code-frame/-/code-frame-7.27.1.tgz",
      "dev": true,
`,
};

export const logo: ProjectFileContent = {
  path: 'apps/web/public/logo.png',
  truncated: false,
  binary: true,
  content: '',
};
