// What the prototype's Project shows inside a Thread (Figma `99:8035`): the
// conversation of "Plan the checkout flow", the sandbox's file tree and its
// Git state, answered over Connect for what the real chat, files and
// git bundles call (`runtime.threads/v1.watchThread`, `files/v1`,
// `git.commands/v1`). Shapes follow the dev fake host (`scripts/fake-host/`)
// and the bundles' contracts. `files/v1` (slice S65d) and `git.commands/v1`
// (S65c) are the window's `FilesService` and `CommandsService` over Connect:
// `filesRoutes(host)` and `gitRoutes(host)` register them on the router
// main's `doric:connect` relay forwards to.

import type { ConnectRouter, ServiceImpl } from '@connectrpc/connect';
import {
  ContentResponseSchema,
  DirectoriesResponseSchema,
  DirectoryResponseSchema,
  FilesService,
  TreeResponseSchema,
} from 'files/contracts/gen/doric/files/v1/files_pb.js';
import {
  BranchesResponseSchema,
  ChangesResponseSchema,
  CommandsService,
  DiffResponseSchema,
  FileDiffResponseSchema,
  StatusResponseSchema,
  SwitchBranchResponseSchema,
} from 'git/contracts/gen/doric/git/commands/v1/commands_pb.js';
import { encode, type OneofMapping } from 'runtime/contracts';

import type { FakeHost } from './harness';
import { EXECUTION } from './settings-host';

/** The sandbox mount, the Thread's working directory. */
export const CWD = '/workspace';

/** The branch the Thread's repository has checked out. */
export const BRANCH = 'fix/checkout-rounding';

/** The one changed file of the working tree. */
export const CHANGED_FILE = 'apps/web/src/checkout/payment-form.tsx';

/** The local branches, the checked-out one first. */
export const BRANCHES = [
  {
    name: BRANCH,
    commit: '4f2a9c1',
    subject: 'Round the checkout total to cents',
  },
  { name: 'main', commit: '9b81d03', subject: 'Release 2.4.0' },
  {
    name: 'feat/apple-pay',
    commit: '2c7e5aa',
    subject: 'Offer Apple Pay on the payment step',
  },
  {
    name: 'feat/address-lookup',
    commit: '71d0f4e',
    subject: 'Look up the shipping address',
  },
] as const;

/** The prompt, the thought, the tool call and the answer of the prototype. */
export const PROMPT =
  'The Pay button in the checkout disappears in dark mode. Can you fix it?';
export const THOUGHT =
  'The button probably sets its own background instead of a theme token.';
export const ANSWER =
  'The button used a hard-coded `bg-white`, so in dark mode it blended into the card. It now uses the `primary` token.';

interface TreeNode {
  readonly name: string;
  readonly path: string;
  readonly type: 'directory' | 'file';
  readonly size?: number;
  readonly children?: readonly TreeNode[];
}

const file = (path: string, size = 1_024): TreeNode => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  type: 'file',
  size,
});

const directory = (path: string, children: readonly TreeNode[]): TreeNode => ({
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  type: 'directory',
  children,
});

/** The workspace tree of the prototype's Files column. */
export const FILE_TREE: readonly TreeNode[] = [
  directory('.github', [
    directory('.github/workflows', [file('.github/workflows/ci.yml', 812)]),
  ]),
  directory('apps', [
    directory('apps/web', [
      directory('apps/web/src', [
        directory('apps/web/src/checkout', [
          file('apps/web/src/checkout/checkout.tsx', 2_310),
          file(CHANGED_FILE, 3_482),
          file('apps/web/src/checkout/shipping-step.tsx', 2_904),
          file('apps/web/src/checkout/use-cart.ts', 1_288),
        ]),
        file('apps/web/src/main.tsx', 402),
        file('apps/web/src/styles.css', 1_930),
      ]),
      file('apps/web/package.json', 688),
      file('apps/web/vite.config.ts', 311),
    ]),
  ]),
  directory('docs', []),
  directory('packages', [
    directory('packages/pricing', [file('packages/pricing/package.json', 420)]),
  ]),
  file('.gitignore', 96),
  file('README.md', 1_544),
  file('package.json', 902),
  file('tsconfig.json', 377),
];

/** The directory of `FILE_TREE` at `path`, if there is one. */
const directoryIn = (
  nodes: readonly TreeNode[],
  path: string,
): TreeNode | undefined => {
  for (const node of nodes) {
    if (node.path === path)
      return node.children === undefined ? undefined : node;
    if (node.children !== undefined && path.startsWith(`${node.path}/`))
      return directoryIn(node.children, path);
  }
  return undefined;
};

/** The source a file viewer reads for every path. */
export const PAYMENT_FORM_SOURCE = `import { Button } from '@/components/ui/button';

import { useCart } from './use-cart';

export function PaymentForm() {
  const { total } = useCart();

  return (
    <form className="flex flex-col gap-4">
      <Button type="submit" className="bg-primary text-primary-foreground">
        Pay {total}
      </Button>
    </form>
  );
}
`;

/** One row of a Thread's durable log, as `watchThread` replays it. */
export interface ThreadEventRow {
  readonly projectId: string;
  readonly threadId: string;
  readonly promptId: string;
  readonly sequence: number;
  readonly type: string;
  readonly event: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

/**
 * The conversation of one Thread: the prompt, a thought, a `grep` call and
 * the answer, one finished turn (`scripts/fake-host/seed.mjs`'s shape). The
 * response names the model that answered (as the runtime's executor records
 * it), so the agent's mark is that model's icon (`99:8035`'s ✳︎).
 */
export const conversation = (input: {
  readonly projectId: string;
  readonly threadId: string;
  readonly at: string;
}): readonly ThreadEventRow[] => {
  const promptId = `${input.threadId.slice(0, 8)}-0000-4000-8000-000000000001`;
  const call = { id: 'call-grep-1', name: 'grep' };
  const events: readonly Record<string, unknown>[] = [
    {
      type: 'prompt.accepted',
      text: PROMPT,
      source: { kind: 'user' },
      queued: false,
    },
    { type: 'prompt.started' },
    { type: 'agent.started' },
    {
      type: 'response.started',
      providerId: EXECUTION.providerId,
      model: EXECUTION.model,
    },
    { type: 'reasoning.delta', delta: THOUGHT },
    {
      type: 'tool.started',
      call: { ...call, payload: { pattern: 'bg-white', path: 'apps/web' } },
    },
    {
      type: 'tool.finished',
      call,
      record: {
        output: `${CHANGED_FILE}:9:      <Button className="bg-white">`,
      },
    },
    { type: 'text.delta', delta: ANSWER },
    {
      type: 'prompt.finished',
      status: 'completed',
      text: ANSWER,
      source: { kind: 'user' },
    },
  ];

  return events.map((event, index) => ({
    projectId: input.projectId,
    threadId: input.threadId,
    promptId,
    sequence: index + 1,
    type: event.type as string,
    event,
    createdAt: input.at,
  }));
};

/**
 * Today's JSON as the proto message `schema` (the host's codec: `null`
 * leaves a field unset), its discriminated oneofs flattened by `oneofs`.
 * The answer is untyped: this CommonJS project sees `@bufbuild/protobuf`'s
 * CJS types, `runtime/contracts` its ESM ones.
 */
export const proto = (
  schema: object,
  value: unknown,
  oneofs: readonly OneofMapping[] = [],
): never =>
  encode(
    schema as unknown as Parameters<typeof encode>[0],
    value,
    oneofs,
  ) as never;

/** The `FilesService` handlers of each host, as its fakes added them. */
const fileHandlers = new WeakMap<
  FakeHost,
  Partial<ServiceImpl<typeof FilesService>>
>();

/** Adds `handlers` to the `FilesService` of `host`. */
export const serveFiles = (
  host: FakeHost,
  handlers: Partial<ServiceImpl<typeof FilesService>>,
): void => {
  fileHandlers.set(host, { ...fileHandlers.get(host), ...handlers });
};

/**
 * Registers the `FilesService` handlers `serveFiles` added for `host` on
 * `router` (none: nothing is registered).
 */
export const filesRoutes =
  (host: FakeHost) =>
  (router: ConnectRouter): void => {
    const handlers = fileHandlers.get(host);
    if (handlers !== undefined) router.service(FilesService, handlers);
  };

/** The `CommandsService` handlers of each host, as its fakes added them. */
const gitHandlers = new WeakMap<
  FakeHost,
  Partial<ServiceImpl<typeof CommandsService>>
>();

/** Adds `handlers` to the `CommandsService` of `host`. */
export const serveGit = (
  host: FakeHost,
  handlers: Partial<ServiceImpl<typeof CommandsService>>,
): void => {
  gitHandlers.set(host, { ...gitHandlers.get(host), ...handlers });
};

/**
 * Registers the `CommandsService` handlers `serveGit` added for `host` on
 * `router` (none: nothing is registered).
 */
export const gitRoutes =
  (host: FakeHost) =>
  (router: ConnectRouter): void => {
    const handlers = gitHandlers.get(host);
    if (handlers !== undefined) router.service(CommandsService, handlers);
  };

/** The `git.commands/v1` calls the window made, by method. */
export interface GitCalls {
  readonly switches: { branch: string; cwd: string; threadId: string }[];
}

/**
 * Serves the sandbox reads (`files/v1`, over Connect through
 * `filesRoutes(host)`) and the Git state (`git.commands/v1`, through
 * `gitRoutes(host)`) of the workspace: one repository at the root,
 * `payment-form.tsx` modified, `BRANCH` checked out. `switchBranch` checks
 * out the branch it names, so every later read answers it.
 */
export const serveSandbox = (host: FakeHost): GitCalls => {
  const calls: GitCalls = { switches: [] };
  let head: string = BRANCH;
  const ready = (value: unknown) => ({ status: 'ready', value });
  const branches = () => ({
    branches: BRANCHES.map((branch) => ({
      ...branch,
      current: branch.name === head,
      worktree: branch.name === head ? CWD : '',
    })),
  });
  const change = {
    path: CHANGED_FILE,
    status: 'modified',
    staged: false,
    unstaged: true,
    indexStatus: ' ',
    worktreeStatus: 'M',
  };

  serveFiles(host, {
    tree: ({ path }) =>
      proto(
        TreeResponseSchema,
        ready({ status: 'listed', path: path ?? '', entries: FILE_TREE }),
      ),
    directory: ({ path }) =>
      proto(
        DirectoryResponseSchema,
        ready({
          status: 'listed',
          path: path ?? '',
          entries: FILE_TREE.map(({ children: _, ...entry }) => entry),
        }),
      ),
    // The Files panel reads its tree per directory (`files/v1@1.3.0`).
    directories: ({ paths }) =>
      proto(
        DirectoriesResponseSchema,
        ready({
          status: 'listed',
          directories: paths.map((path) => {
            const children =
              path === '' ? FILE_TREE : directoryIn(FILE_TREE, path)?.children;
            return children === undefined
              ? { path, status: 'not_found' }
              : {
                  path,
                  status: 'listed',
                  entries: children.map(({ children: _, ...entry }) => entry),
                };
          }),
        }),
      ),
    content: ({ path }) =>
      proto(
        ContentResponseSchema,
        ready({
          status: 'read',
          path,
          content: PAYMENT_FORM_SOURCE,
          truncated: false,
          binary: false,
        }),
      ),
  });

  serveGit(host, {
    status: () =>
      proto(
        StatusResponseSchema,
        ready({
          repo: true,
          root: CWD,
          head,
          detached: false,
          unborn: false,
          upstream: `origin/${head}`,
          ahead: 0,
          behind: 0,
          dirty: { staged: 0, modified: 1, untracked: 0 },
          conflicted: 0,
          operation: null,
          worktree: false,
          shallow: false,
          stash: 0,
          submodules: 0,
        }),
      ),
    branches: () => proto(BranchesResponseSchema, ready(branches())),
    switchBranch: ({ threadId, branch, cwd }) => {
      calls.switches.push({ threadId, branch, cwd });
      head = branch;

      return proto(SwitchBranchResponseSchema, ready(branches()));
    },
    changes: ({ path }) =>
      proto(
        ChangesResponseSchema,
        ready({
          status: 'read',
          ...(path === undefined ? {} : { path }),
          repositories: [
            { path: '', changes: [change], added: 142, removed: 37 },
          ],
        }),
      ),
    diff: ({ path }) =>
      proto(
        DiffResponseSchema,
        ready({
          status: 'read',
          ...(path === undefined ? {} : { path }),
          repositories: [],
        }),
      ),
    fileDiff: ({ repository }) =>
      proto(
        FileDiffResponseSchema,
        ready({
          status: 'read',
          diff: {
            ...change,
            repository,
            original: PAYMENT_FORM_SOURCE.replace(
              'bg-primary text-primary-foreground',
              'bg-white',
            ),
            modified: PAYMENT_FORM_SOURCE,
            binary: false,
            truncated: false,
          },
        }),
      ),
  });

  return calls;
};
