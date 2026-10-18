// The git data the stories draw: one Project ("Storefront") whose Thread
// works in the sandbox's workspace repository, with the uncommitted changes,
// branches, summaries, comparisons and credentials the host would answer.

import type { Project, Thread } from 'runtime/contracts';

import type { Credential } from '../../src/client/domain/credentials.js';
import type {
  GitBranches,
  ThreadGit,
} from '../../src/client/domain/thread-git.js';
import type {
  ProjectChanges,
  ProjectFileChange,
  ProjectFileDiff,
} from '../../src/contracts/index.js';

const at = '2026-10-14T09:12:00.000Z';

export const project: Project = {
  id: 'project-storefront',
  name: 'Storefront',
  color: 'blue',
  state: 'ready',
  configRevision: 4,
  createdAt: '2026-09-30T14:02:00.000Z',
  updatedAt: at,
  startedAt: at,
};

export const thread: Thread = {
  id: 'thread-checkout-totals',
  projectId: project.id,
  name: 'Fix checkout totals rounding',
  state: 'ready',
  lastSequence: 128,
  cwd: '/workspace',
  cwdRepo: 'github',
  createdAt: '2026-10-14T08:40:00.000Z',
  updatedAt: at,
  lastExecutionMs: 48_200,
};

export const runningThread: Thread = {
  ...thread,
  id: 'thread-checkout-running',
  state: 'running',
  activePromptId: 'prompt-17',
  executionStartedAt: at,
};

export const nestedThread: Thread = {
  ...thread,
  id: 'thread-design-tokens',
  name: 'Tokens: dark palette contrast',
  cwd: '/workspace/packages/design-tokens/src/themes/high-contrast',
};

const change = (
  path: string,
  status: ProjectFileChange['status'],
  indexStatus: string,
  worktreeStatus: string,
  originalPath?: string,
): ProjectFileChange => ({
  path,
  status,
  staged: indexStatus !== ' ' && indexStatus !== '?',
  unstaged: worktreeStatus !== ' ',
  indexStatus,
  worktreeStatus,
  ...(originalPath === undefined ? {} : { originalPath }),
});

/** The workspace repository: one of each kind of change. */
export const workspaceRepository: ProjectChanges['repositories'][number] = {
  path: '',
  added: 142,
  removed: 37,
  changes: [
    change('src/components/Checkout.tsx', 'modified', ' ', 'M'),
    change('src/components/CartSummary.tsx', 'added', 'A', ' '),
    change('src/lib/pricing.ts', 'modified', 'M', 'M'),
    change('src/lib/legacy-coupons.ts', 'deleted', 'D', ' '),
    change('src/hooks/useCart.ts', 'renamed', 'R', ' ', 'src/hooks/cart.ts'),
    change('docs/checkout-flow.md', 'untracked', '?', '?'),
    change('package.json', 'modified', ' ', 'M'),
  ],
};

/** A nested repository whose rebase stopped on a conflict. */
export const tokensRepository: ProjectChanges['repositories'][number] = {
  path: 'packages/design-tokens',
  added: 12,
  removed: 4,
  changes: [
    change('src/build.ts', 'conflicted', 'U', 'U'),
    change('tokens/color.json', 'modified', 'M', ' '),
  ],
};

/** A repository with no uncommitted change. */
export const cleanRepository: ProjectChanges['repositories'][number] = {
  path: 'vendor/payments-sdk',
  added: 0,
  removed: 0,
  changes: [],
};

export const changes: ProjectChanges = {
  repositories: [workspaceRepository],
};

export const multiRepositoryChanges: ProjectChanges = {
  repositories: [workspaceRepository, tokensRepository, cleanRepository],
};

export const cleanChanges: ProjectChanges = {
  repositories: [{ ...cleanRepository, path: '' }],
};

export const noRepositories: ProjectChanges = { repositories: [] };

/** A large refactor: many changed files under many directories. */
export const manyChanges: ProjectChanges = {
  repositories: [
    {
      path: '',
      added: 1840,
      removed: 1312,
      changes: [
        'checkout',
        'cart',
        'catalog',
        'account',
        'orders',
        'search',
      ].flatMap((feature, index) => [
        change(`src/features/${feature}/index.ts`, 'modified', ' ', 'M'),
        change(
          `src/features/${feature}/${feature}-view.tsx`,
          index % 3 === 0 ? 'added' : 'modified',
          index % 3 === 0 ? 'A' : ' ',
          index % 3 === 0 ? ' ' : 'M',
        ),
        change(
          `src/features/${feature}/${feature}.test.ts`,
          'untracked',
          '?',
          '?',
        ),
      ]),
    },
  ],
};

// Comparisons ----------------------------------------------------------------

const checkoutOriginal = `import { formatPrice } from '../lib/pricing';
import type { Cart } from '../hooks/cart';

export function Checkout({ cart }: { cart: Cart }) {
  const subtotal = cart.items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0,
  );
  const tax = subtotal * 0.08;
  const total = subtotal + tax;

  return (
    <section className="checkout">
      <h2>Checkout</h2>
      <p>Subtotal: {formatPrice(subtotal)}</p>
      <p>Tax: {formatPrice(tax)}</p>
      <p className="total">Total: {formatPrice(total)}</p>
      <button type="submit">Place order</button>
    </section>
  );
}
`;

const checkoutModified = `import { formatPrice, roundCents, taxFor } from '../lib/pricing';
import type { Cart } from '../hooks/useCart';
import { CartSummary } from './CartSummary';

export function Checkout({ cart, region }: { cart: Cart; region: string }) {
  const subtotal = roundCents(
    cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0),
  );
  const tax = roundCents(taxFor(region, subtotal));
  const total = roundCents(subtotal + tax);

  return (
    <section className="checkout">
      <h2>Checkout</h2>
      <CartSummary cart={cart} />
      <p>Subtotal: {formatPrice(subtotal)}</p>
      <p>Tax ({region}): {formatPrice(tax)}</p>
      <p className="total">Total: {formatPrice(total)}</p>
      <button type="submit" disabled={cart.items.length === 0}>
        Place order
      </button>
    </section>
  );
}
`;

const cartSummary = `import type { Cart } from '../hooks/useCart';

export function CartSummary({ cart }: { cart: Cart }) {
  const count = cart.items.reduce((sum, item) => sum + item.quantity, 0);
  return (
    <p className="cart-summary">
      {count} {count === 1 ? 'item' : 'items'} in your cart
    </p>
  );
}
`;

const legacyCoupons = `/** @deprecated Coupons moved to the pricing service. */
export const applyCoupon = (total: number, code: string): number =>
  code === 'WELCOME10' ? total * 0.9 : total;
`;

const diffOf = (
  repository: string,
  file: ProjectFileChange,
  original: string,
  modified: string,
  extra: Partial<Pick<ProjectFileDiff, 'binary' | 'truncated'>> = {},
): ProjectFileDiff => ({
  ...file,
  repository,
  original,
  modified,
  binary: false,
  truncated: false,
  ...extra,
});

const [checkout, summary, , legacy] = workspaceRepository.changes as [
  ProjectFileChange,
  ProjectFileChange,
  ProjectFileChange,
  ProjectFileChange,
];

export const checkoutDiff = diffOf(
  '',
  checkout,
  checkoutOriginal,
  checkoutModified,
);

export const addedDiff = diffOf('', summary, '', cartSummary);

export const deletedDiff = diffOf('', legacy, legacyCoupons, '');

export const binaryDiff = diffOf(
  '',
  change('public/images/checkout-hero.png', 'modified', ' ', 'M'),
  '',
  '',
  { binary: true },
);

export const truncatedDiff = diffOf(
  '',
  change('src/generated/catalog.json', 'modified', ' ', 'M'),
  `{\n  "products": [\n    { "sku": "TSHIRT-001", "price": 1999 },\n    { "sku": "MUG-014", "price": 1250 }\n`,
  `{\n  "products": [\n    { "sku": "TSHIRT-001", "price": 2199 },\n    { "sku": "MUG-014", "price": 1250 },\n    { "sku": "TOTE-003", "price": 1800 }\n`,
  { truncated: true },
);

// Thread summaries -----------------------------------------------------------

type Repository = Extract<ThreadGit, { readonly repo: true }>;

export const onBranch: Repository = {
  repo: true,
  root: '/workspace',
  head: 'fix/checkout-rounding',
  detached: false,
  unborn: false,
  upstream: 'origin/fix/checkout-rounding',
  ahead: 2,
  behind: 1,
  dirty: { staged: 3, modified: 3, untracked: 1 },
  conflicted: 0,
  operation: null,
  worktree: false,
  shallow: false,
  stash: 1,
  submodules: 0,
};

export const cleanBranch: Repository = {
  ...onBranch,
  head: 'main',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  dirty: { staged: 0, modified: 0, untracked: 0 },
  stash: 0,
};

export const detached: Repository = {
  ...onBranch,
  head: '4f9c2ab',
  detached: true,
  upstream: null,
  ahead: 0,
  behind: 0,
};

export const rebasing: Repository = {
  ...onBranch,
  root: '/workspace/packages/design-tokens',
  head: 'feat/high-contrast',
  upstream: 'origin/main',
  ahead: 5,
  behind: 12,
  dirty: { staged: 1, modified: 0, untracked: 0 },
  conflicted: 1,
  operation: 'rebase',
  worktree: true,
};

export const notRepository: ThreadGit = { repo: false };

export const environmentUnavailable: ThreadGit = {
  repo: false,
  status: 'unavailable',
};

// Branches -------------------------------------------------------------------

export const branches: GitBranches = {
  branches: [
    {
      name: 'fix/checkout-rounding',
      current: true,
      commit: 'a1c93e0',
      subject: 'Round tax and totals to cents before formatting',
      worktree: '/workspace',
    },
    {
      name: 'main',
      current: false,
      commit: '4f9c2ab',
      subject: 'Merge pull request #212 from storefront/cart-badge',
      worktree: '',
    },
    {
      name: 'feat/high-contrast',
      current: false,
      commit: '9d07b51',
      subject: 'Add the high-contrast theme to the token build',
      worktree: '/workspace/.worktrees/high-contrast',
    },
    {
      name: 'chore/upgrade-react-19',
      current: false,
      commit: '6be1f4d',
      subject: 'Upgrade React and the testing library',
      worktree: '',
    },
    {
      name: 'experiment/one-page-checkout-with-saved-addresses-and-express-pay',
      current: false,
      commit: 'c3d2e8a',
      subject:
        'WIP: collapse shipping and payment into one step, prefill saved addresses',
      worktree: '',
    },
  ],
};

export const blockedBranches: GitBranches = {
  ...branches,
  blocked: 'Commit or stash the changes in /workspace before switching.',
};

export const branchesUnavailable: GitBranches = {
  status: 'unavailable',
  branches: [],
  blocked: 'Environment unavailable.',
};

export const noBranches: GitBranches = { branches: [] };

// Credentials ----------------------------------------------------------------

export const credentials: readonly Credential[] = [
  {
    id: 'cred-git-work',
    kind: 'GIT',
    name: 'Work identity',
    username: 'Ada Lovelace',
    email: 'ada@storefront.dev',
    hasSecret: false,
  },
  {
    id: 'cred-git-personal',
    kind: 'GIT',
    name: 'Personal identity',
    username: 'ada',
    email: 'ada@example.com',
    hasSecret: false,
  },
  {
    id: 'cred-github-bot',
    kind: 'API_TOKEN',
    name: 'GitHub storefront-bot',
    hasSecret: true,
  },
  {
    id: 'cred-registry',
    kind: 'USERNAME_PASSWORD',
    name: 'Registry login',
    username: 'ci',
    hasSecret: true,
  },
];
