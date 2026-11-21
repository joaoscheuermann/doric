# sandbox

`sandbox` is the boundary between an AI agent and the machine it works on. It
defines one provider-neutral contract for an isolated workspace, so the same
agent code runs on a Docker container or a Firecracker microVM without change.
A provider supplies the low-level runtime; `createSandbox` adds root-confined
paths, Git, file, diff, SSH and lifecycle helpers on top of it.

Part of [Doric](../../README.md). Feature docs:
[Sandboxes](../../docs/features/sandboxes.md),
[Files](../../docs/features/files.md), [Git](../../docs/features/git.md) and
[Resource monitor](../../docs/features/resource-monitor.md).

Who uses it:

- **Provider packages** implement `SandboxProvider` and use the process
  helpers: [`docker-sandbox`](../docker-sandbox/README.md) and
  [`firecracker-sandbox`](../firecracker-sandbox/README.md).
- **Sandbox bundles** call `createSandbox` over a provider wrapped by
  `createVmRegistry` and serve the result to the rest of the app:
  [`docker`](../../bundles/sandboxes/docker/README.md) and
  [`firecracker`](../../bundles/sandboxes/firecracker/README.md).
- **Other packages and bundles** use the types and the workspace visibility
  helpers: [`sandpool`](../sandpool/README.md) leases `SandboxSession`s, the
  [`files`](../../bundles/features/files/README.md) feature lists directories
  and trees, the [`git`](../../bundles/features/git/README.md) feature lists
  repositories, and
  [`runtime`](../../bundles/runtime/runtime/README.md) checks path kinds.

## Entry point

`package.json` exports one entry, `sandbox` (ESM, `./dist/index.js` with
`./dist/index.d.ts`; the `@org/source` condition resolves to
`./src/index.ts`). It re-exports every module of `src/lib`
([`index.ts`](src/index.ts)). The package has no runtime dependency besides
`tslib` and Node's `node:buffer`, `node:net`, `node:path` and
`node:string_decoder`.

## Usage

```ts
import { createDockerClient } from 'docker-sandbox';
import { createSandbox } from 'sandbox';

const sandbox = await createSandbox({
  provider: createDockerClient(),
  image: 'node:22-bookworm',
  resources: { cpuCount: 2, memoryMiB: 2048, diskMiB: 4096 },
  network: { mode: 'disabled' },
  workspace: projectId,
});

try {
  await sandbox.writeFile('notes/todo.md', '# Todo\n');
  const result = await sandbox.exec({ cmd: ['cat', 'notes/todo.md'] });
  console.log(result.stdout);
} finally {
  await sandbox.dispose();
}
```

## Sessions

### `createSandbox(options: CreateSandboxOptions): Promise<SandboxSession>`

Validates the options, provisions one runtime through `options.provider` and
returns a session over it ([`sandbox.ts`](src/lib/sandbox.ts)).

```ts
interface CreateSandboxOptions {
  readonly provider: SandboxProvider;
  readonly image: string;
  readonly imagePullPolicy?: 'always' | 'if-not-present';
  readonly name?: string;
  readonly workspace?: string;
  readonly root?: string;
  readonly resources: SandboxResources;
  readonly network?: SandboxNetworkPolicy;
  readonly timeoutMs?: number;
}

interface SandboxResources {
  readonly cpuCount: number;
  readonly memoryMiB: number;
  readonly diskMiB: number;
}
```

| Option            | Default        | Behavior                                                                                               |
| ----------------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| `provider`        | required       | The `SandboxProvider` that provisions the runtime.                                                     |
| `image`           | required       | The OCI image, passed to the provider unchanged.                                                       |
| `imagePullPolicy` | none           | Passed to the provider unchanged.                                                                      |
| `name`            | none           | Passed to the provider unchanged.                                                                      |
| `workspace`       | none (scratch) | The durable workspace the sandbox serves, passed to the provider unchanged.                            |
| `root`            | `/workspace`   | The workspace root. It must start with `/` and contain no `..`; trailing slashes are removed.          |
| `resources`       | required       | Every value must be a positive integer.                                                                |
| `network`         | `disabled`     | Normalized by [`normalizeSandboxNetwork`](#normalizesandboxnetworkpolicy) before the provider sees it. |
| `timeoutMs`       | none           | Provisioning timeout, passed to the provider unchanged.                                                |

In order, `createSandbox` validates `resources` (throwing
`RangeError('<name> must be a positive integer')` for the first bad value),
normalizes `root` (throwing `Error('Sandbox root must be an absolute
normalized path: <root>')`), normalizes the network policy (throwing its
errors), and only then calls `provider.provision` with
`{ image, imagePullPolicy, name, workspace, root, resources, network,
timeoutMs }`, where `root` and `network` are the normalized values. A
validation error therefore provisions nothing. A provisioning error is
returned unchanged ([`sandbox.ts`](src/lib/sandbox.ts)).

How a `workspace` outlives its sandbox is the provider's decision; this
package only forwards the name. Without a `workspace` the sandbox is scratch
([`sandbox.ts`](src/lib/sandbox.ts)).

### `SandboxSession`

```ts
interface Sandbox {
  readonly id: string;
  readonly root: string;
  start?(input: SandboxProcessInput): Promise<SandboxProcess>;
  exec(input: SandboxExecInput): Promise<SandboxExecResult>;
  stats?(): Promise<SandboxStats | undefined>;
  cloneRepo(input: CloneRepoInput): Promise<ClonedRepo>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  putFile(path: string, bytes: Uint8Array): Promise<void>;
  getFile(path: string): Promise<Uint8Array>;
  diff(input?: SandboxDiffInput): Promise<string>;
  ssh(): Promise<SandboxSshAccess | undefined>;
}

interface SandboxSession extends Sandbox {
  dispose(): Promise<void>;
}
```

`start` and `stats` are optional on `Sandbox`; the session `createSandbox`
returns always has both ([`types/sandbox.ts`](src/lib/types/sandbox.ts)). `id`
is the runtime's id and `root` the normalized root. Every member behaves as
follows ([`sandbox.ts`](src/lib/sandbox.ts)):

| Member                  | Behavior                                                                                                                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exec(input)`           | Runs `runtime.exec` with `cwd` resolved under the root (the root when omitted). A non-zero exit is a result, not an error.                                                                                                                                                       |
| `start(input)`          | Runs `runtime.start` with `cwd` resolved the same way. Throws `Error('Sandbox provider does not support live processes')` when the runtime has no `start`.                                                                                                                       |
| `stats()`               | Returns `runtime.stats()`, or `undefined` when the runtime has no `stats`. Callers report `undefined` as unknown.                                                                                                                                                                |
| `readFile(path)`        | `runtime.getFile` on the resolved path, decoded as UTF-8.                                                                                                                                                                                                                        |
| `getFile(path)`         | `runtime.getFile` on the resolved path, as bytes.                                                                                                                                                                                                                                |
| `writeFile(path, text)` | Encodes `text` as UTF-8, then writes it as `putFile` does.                                                                                                                                                                                                                       |
| `putFile(path, bytes)`  | Resolves the path, runs `mkdir -p` on its parent directory, then calls `runtime.putFile`. The resolved path must name a file below a directory, else `Error('Sandbox file path must include a file name: <path>')`.                                                              |
| `cloneRepo(input)`      | See [Git](#git).                                                                                                                                                                                                                                                                 |
| `diff(input?)`          | See [Git](#git).                                                                                                                                                                                                                                                                 |
| `ssh()`                 | Returns `runtime.ssh()`: the access details, or `undefined` when SSH is not enabled.                                                                                                                                                                                             |
| `dispose()`             | Calls `runtime.dispose()` and marks the session disposed once it resolves. Only a call made after one has resolved returns at once; overlapping calls each call `runtime.dispose()`. If `runtime.dispose()` rejects, the session stays usable and a later `dispose` tries again. |

After `dispose` completes, every other member throws
`Error('Sandbox has been disposed: <id>')`. `exec`, `start`, `stats` and `ssh`
throw this synchronously; the other members reject with it.

### Path confinement

Every session path (`cwd`, file paths, the clone directory) is resolved the
same way ([`sandbox.ts`](src/lib/sandbox.ts)): a relative path is joined to
the root; an absolute path is kept. Empty segments are dropped; `.` segments
are kept (`./a` becomes `/workspace/./a`), so no further normalization is
done. The path is
rejected with `Error('Sandbox paths must stay under <root>: <path>')` when any
segment is `..` (even one that would stay below the root) or when its leading
segments are not the root's segments. Paths are not resolved against symbolic
links inside the sandbox.

### Command failures

Commands the session runs on its own behalf (`mkdir -p`, the Git commands)
fail with `Error('Sandbox command failed with exit code <code>')` when they
exit non-zero; their output is not included in the message
([`sandbox.ts`](src/lib/sandbox.ts)).

### Git

```ts
type GitAuth =
  | {
      readonly kind: 'token';
      readonly token: string;
      readonly username?: string;
    }
  | {
      readonly kind: 'basic';
      readonly username: string;
      readonly password: string;
    };

interface CloneRepoInput {
  readonly url: string;
  readonly directory?: string; // default 'repo'
  readonly branch?: string;
  readonly commit?: string;
  readonly auth?: GitAuth;
  readonly timeoutMs?: number;
}

interface ClonedRepo {
  readonly path: string; // absolute path in the sandbox
  readonly commit: string; // the checked-out commit
}

interface SandboxDiffInput {
  readonly cwd?: string;
  readonly paths?: readonly string[];
}
```

`cloneRepo` runs, inside the sandbox and with `cwd` at the root
([`sandbox.ts`](src/lib/sandbox.ts)):

1. `git clone [--branch <branch>] <url> <directory>`, where `directory`
   resolves under the root;
2. when `commit` is set, `git -C <directory> fetch origin <commit>` and then
   `git -C <directory> checkout --detach <commit>`;
3. `git -C <directory> rev-parse HEAD`, whose trimmed output is `commit`.

`timeoutMs` applies to each command. With `auth`, the clone and fetch receive
the environment `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=http.extraHeader`,
`GIT_CONFIG_VALUE_0=Authorization: Basic <base64(username:secret)>`, where the
username of a token defaults to `x-access-token`; the credential is not put in
the URL or the repository's configuration. A failing command throws as in
[Command failures](#command-failures). On success the session remembers the
directory for `diff`. The clone runs in the sandbox, so a remote URL is
reachable only when the provider grants egress.

`diff` runs `git diff`, followed by `-- <paths...>` when `paths` is non-empty,
and returns its stdout. Its working directory is `cwd` resolved under the
root, else the last cloned directory, else the root. `paths` are passed to Git
as given. A non-zero exit throws.

## Network policy

```ts
interface SandboxNetworkPolicy {
  readonly mode: 'disabled' | 'egress';
  readonly ssh?:
    | boolean
    | {
        readonly bindAddress?: string;
        readonly advertisedHost?: string;
        readonly port?: number;
      };
  readonly dnsServers?: readonly string[];
  readonly allowPrivate?: readonly {
    readonly cidr: string;
    readonly protocol: 'tcp' | 'udp';
    readonly ports: readonly number[];
  }[];
}

type NormalizedSandboxNetworkPolicy = Omit<SandboxNetworkPolicy, 'ssh'> & {
  readonly mode: 'disabled' | 'egress';
  readonly ssh:
    | false
    | {
        readonly bindAddress: string;
        readonly advertisedHost?: string;
        readonly port?: number;
      };
};
```

### `normalizeSandboxNetwork(policy)`

`normalizeSandboxNetwork(policy: SandboxNetworkPolicy | undefined):
NormalizedSandboxNetworkPolicy` validates a policy and returns the one
providers enforce ([`sandbox.ts`](src/lib/sandbox.ts)):

- An absent policy is `{ mode: 'disabled', ssh: false }`.
- `ssh` that is absent or `false` normalizes to `false`. `true` means `{}`.
  An SSH object gets `bindAddress` `127.0.0.1` by default; it must be an IPv4
  or IPv6 literal (`Error('SSH bindAddress must be an IP literal')`). A
  non-loopback address (anything but `::1` or `127.*`) requires
  `advertisedHost` (`Error('A non-loopback SSH bindAddress requires
advertisedHost')`). `port`, when set, must be an integer from 1 to 65535
  (`RangeError('SSH port must be between 1 and 65535')`).
- Enabled SSH forces `mode` to `egress`.
- With an effective `egress` mode, `dnsServers` must hold at least one entry
  (`Error('Effective egress networking requires at least one DNS server')`).
  Each DNS server, in either mode, must be an IPv4 literal
  (`Error('DNS server must be an IPv4 literal: <server>')`).
- Each `allowPrivate` rule needs an IPv4 CIDR with a prefix from 0 to 32
  (`Error('Private network exception must use a valid CIDR: <cidr>')`) and a
  non-empty list of integer ports from 1 to 65535
  (`Error('Private network exception has invalid ports: <cidr>')`).
  `protocol` is not checked at run time.
- The result holds `mode` and `ssh`, plus `dnsServers` and `allowPrivate` only
  when the input has them.

Providers enforce the policy; this package only validates it
([`sandbox.ts`](src/lib/sandbox.ts)). How a provider
applies SSH (loopback bind, key-only `root` access) is described in its
README.

## Implementing a provider

```ts
interface SandboxProvider {
  provision(input: SandboxProvisionInput): Promise<SandboxRuntime>;
}

interface SandboxProvisionInput {
  readonly image: string;
  readonly imagePullPolicy?: 'always' | 'if-not-present';
  readonly name?: string;
  readonly workspace?: string;
  readonly root: string;
  readonly resources: SandboxResources;
  readonly network: NormalizedSandboxNetworkPolicy;
  readonly timeoutMs?: number;
}

interface SandboxRuntime {
  readonly id: string;
  start?(input: SandboxProcessInput): Promise<SandboxProcess>;
  exec(input: SandboxExecInput): Promise<SandboxExecResult>;
  stats?(): Promise<SandboxStats>;
  putFile(path: string, bytes: Uint8Array): Promise<void>;
  getFile(path: string): Promise<Uint8Array>;
  ssh(): Promise<SandboxSshAccess | undefined>;
  dispose(): Promise<void>;
}
```

A runtime receives absolute, root-confined paths and a resolved `cwd`. It
consumes the normalized `network`, the explicit `resources` and `workspace`;
policy belongs to the provider, not to this package. `start` and `stats` are
optional: a provider that cannot see its sandbox's accounting leaves `stats`
out rather than answering an empty reading. `ssh()` answers `undefined` when
SSH is disabled ([`types/sandbox.ts`](src/lib/types/sandbox.ts)). A session
does not serialize `dispose`: overlapping calls each call `runtime.dispose()`,
and a call after a rejection calls it again, so a provider's `dispose` must
tolerate a second call, including one while the first is in flight
([`sandbox.ts`](src/lib/sandbox.ts)).

```ts
interface SandboxExecInput {
  readonly cmd: readonly string[];
  readonly cwd?: string;
  readonly env?: readonly string[]; // 'NAME=value'
  readonly user?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly tty?: boolean;
}

interface SandboxExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: Uint8Array;
  readonly stderrBytes: Uint8Array;
}

interface SandboxProcessInput extends SandboxExecInput {
  readonly cols?: number;
  readonly rows?: number;
  readonly onOutput?: (output: SandboxProcessOutput) => void;
}

interface SandboxProcessOutput {
  readonly stream: 'stdout' | 'stderr';
  readonly data: string;
}

interface SandboxProcess {
  readonly result: Promise<SandboxExecResult>; // at most the last MiB of each stream
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  terminate(): Promise<void>; // ends the remote process tree, not just the transport
}

interface SandboxStats {
  readonly cpuPercent?: number; // 0..100 of the sandbox's own CPU allotment
  readonly cpuCount?: number; // cores the quota allows
  readonly memoryUsedBytes?: number;
  readonly memoryLimitBytes?: number; // absent where no limit is enforced
  readonly at: string; // ISO-8601 time of the reading
}

interface SandboxSshAccess {
  readonly host: string;
  readonly port: number;
  readonly username: 'root';
  readonly privateKey: string;
  readonly knownHosts: string;
  readonly hostKeyFingerprint: string;
}
```

With `tty`, a live process reports stdout and stderr combined as stdout
([`types/sandbox.ts`](src/lib/types/sandbox.ts)).

### Process helpers

Provider process transports share three helpers
([`process.ts`](src/lib/process.ts)):

- `captureProcessOutput(input: SandboxProcessInput)` returns
  `{ append(stream: 'stdout' | 'stderr', chunk: Uint8Array): void; finish(exitCode: number | null): SandboxExecResult }`.
  `append` keeps the last 1 MiB (1,048,576 bytes) of each stream and calls
  `input.onOutput` with each chunk decoded as UTF-8; a character split across
  chunks is delivered whole with the later chunk, and empty text is not
  delivered. `finish` flushes the decoders and, for each stream that exceeded
  1 MiB, replaces its first bytes with `[earlier output truncated]\n` and drops
  any partial UTF-8 character left at the cut, so the result stays within
  1 MiB per stream.
- `processTerminationScript(pidFile: string): string` returns a POSIX shell
  script that reads a process id from `pidFile`, sends `SIGKILL` to every
  process whose session id is that process (found through `/proc/*/stat`, so
  job groups started in the foreground are included), then to the process
  itself, and removes `pidFile`. It does nothing when `pidFile` is unreadable
  and exits 1 when it holds no number. It needs a Linux `/proc`.
- `quote(value: string): string` single-quotes a value for the shell
  (`'` becomes `'\''`).

## Running-machine registry

```ts
type VmProvider = 'docker' | 'firecracker';
type RunningVm = { readonly id: string; readonly provider: VmProvider };
type VmRegistry = {
  readonly provider: SandboxProvider;
  list(): readonly RunningVm[];
  find(id: string): RunningVm | undefined;
};

function createVmRegistry(
  name: VmProvider,
  provider: SandboxProvider,
): VmRegistry;
```

`createVmRegistry` wraps a provider so the app can list the machines it runs
([`vms.ts`](src/lib/vms.ts)). Provision through `registry.provider`:

- After `provider.provision` succeeds, the registry records
  `{ id: runtime.id, provider: name }` under the runtime's id. A failed
  provision records nothing.
- It returns a runtime that forwards every member to the provider's runtime
  (`start` and `stats` only when the provider's runtime has them). Its
  `dispose` awaits the provider's `dispose` and then removes the entry; when
  that `dispose` rejects, the entry stays listed.
- `list()` returns the entries in the order their ids were first recorded;
  `find(id)` returns one entry or `undefined`. Both are in memory and
  synchronous; nothing is persisted.
- The registry holds one entry per id. When a provider returns runtimes with
  the same id (as a provider does when several leases share the container of
  one durable workspace), they share that entry, and disposing any one of them
  removes it while the others still run.

## Workspace visibility helpers

The file views, the `tree` tool and the Git views read a workspace through
these helpers. The listing helpers (`listSandboxDirectory`, `listSandboxTree`,
`listSandboxDirectories`) all apply the same [visibility rules](#visibility-rules);
`listSandboxRepos` and `workspacePathKind` apply none of them
([`files.ts`](src/lib/files.ts), [`types/files.ts`](src/lib/types/files.ts)).
Each takes a `SandboxReader`, which a full `Sandbox` satisfies and so does any
object that can run a command and report its text output:

```ts
type SandboxReader = Pick<Sandbox, 'root'> & {
  exec(
    input: SandboxExecInput,
  ): Promise<Pick<SandboxExecResult, 'exitCode' | 'stdout' | 'stderr'>>;
};
```

### Exports

```ts
function listSandboxDirectory(
  sandbox: SandboxReader,
  input?: SandboxListInput,
): Promise<SandboxListResult>;
function listSandboxTree(
  sandbox: SandboxReader,
  input?: SandboxListInput,
): Promise<SandboxTreeResult>;
function listSandboxDirectories(
  sandbox: SandboxReader,
  input: SandboxDirectoriesInput,
): Promise<readonly SandboxDirectoryResult[]>;
function listSandboxRepos(sandbox: SandboxReader): Promise<SandboxReposResult>;
function workspacePathKind(
  sandbox: SandboxReader,
  value?: string,
): Promise<WorkspacePathKind | 'escaped'>;
```

- `listSandboxDirectory` lists one level of a directory. File entries carry
  `size` in bytes, measured with `wc -c` in batches of 256 files; a batch that
  fails leaves its files without `size`.
- `listSandboxTree` lists a directory recursively; each directory entry has
  `children` (empty when everything under it is hidden). Entries carry no
  `size`.
- `listSandboxDirectories` lists several directories one level each in one
  command, the read a tree that loads per directory makes. Each listing applies
  the rules `listSandboxTree` from `input.root` (default: the workspace root)
  applies, in the same order, so a directory listed here holds the children the
  recursive listing nests under it; a directory outside `input.root` is its own
  tree root. When `input.root` escapes the workspace, the workspace root is
  used as the tree root, with no `escaped` result and no error. Results follow
  `input.paths`, one per path; entries carry no
  `size`. When every path escapes, it runs nothing. When the command reports no
  kind for a listed directory, it throws
  `Error('Listing workspace directories failed: <stderr or "exit <code>">')`.
  `exclude` is not supported here.
- `listSandboxRepos` runs two commands: a path-kind check of the workspace
  root (`missing` or `not_directory` when it is not a directory), then
  `find <root> ( -name .git ) -prune -print`. It finds every `.git` (a
  directory for a clone, a file for a submodule or linked worktree) without
  reading inside it, and returns the repository roots, sorted and reduced to
  the outermost of any nesting. Hidden, default-ignored and `.gitignore`d
  directories are searched too. A failing `find` answers `missing`. The
  result's `path` is always `''`.
- `workspacePathKind` reports what a workspace-relative path is, without
  reading it; `value` defaults to `''`, the root. It answers `'escaped'` when
  the path leaves the root, and `'missing'` when the check command fails.

### Data shapes

```ts
type SandboxEntryType = 'directory' | 'file';
interface SandboxEntry {
  readonly name: string;
  readonly path: string; // workspace-relative
  readonly type: SandboxEntryType;
  readonly size?: number;
}
type SandboxTreeNode = SandboxEntry & {
  readonly children?: readonly SandboxTreeNode[];
};
interface SandboxListing {
  readonly path: string;
  readonly entries: readonly SandboxEntry[];
}
interface SandboxTree {
  readonly path: string;
  readonly entries: readonly SandboxTreeNode[];
}

interface SandboxListInput {
  readonly path?: string; // workspace-relative; '' or omitted is the root
  readonly exclude?: readonly string[]; // glob patterns kept hidden
}
interface SandboxDirectoriesInput {
  readonly paths: readonly string[];
  readonly root?: string;
}

type SandboxListFailure =
  | { readonly status: 'escaped'; readonly message: string }
  | { readonly status: 'missing' }
  | { readonly status: 'not_directory' }
  | { readonly status: 'invalid_exclude'; readonly message: string }
  | { readonly status: 'excluded_root'; readonly name: string };
type SandboxListResult =
  | ({ readonly status: 'listed' } & SandboxListing)
  | SandboxListFailure;
type SandboxTreeResult =
  | ({ readonly status: 'listed' } & SandboxTree)
  | SandboxListFailure;
type SandboxDirectoryResult =
  | ({ readonly status: 'listed' } & SandboxListing)
  | { readonly status: 'escaped'; readonly message: string }
  | { readonly status: 'missing' }
  | { readonly status: 'not_directory' };

interface SandboxRepo {
  readonly path: string;
} // '' is the workspace root
interface SandboxRepos {
  readonly path: string;
  readonly repositories: readonly SandboxRepo[];
}
type SandboxReposFailure =
  | { readonly status: 'missing' }
  | { readonly status: 'not_directory' };
type SandboxReposResult =
  | ({ readonly status: 'listed' } & SandboxRepos)
  | SandboxReposFailure;

type WorkspacePathKind = 'directory' | 'file' | 'missing' | 'other';
```

Every `path` in a result is relative to the workspace root, `''` being the
root. The failures above are answers, not exceptions: callers turn them into
tool error lines or HTTP status codes. Two cases do throw:
`listSandboxDirectories` when its command reports no kind (above), and every
helper when `sandbox.exec` itself rejects, which propagates unchanged.

### Visibility rules

([`files.ts`](src/lib/files.ts))

- **Confinement.** A requested path is joined to the root (or kept when
  absolute) and normalized; it fails with `escaped` and
  `Path escapes workspace: <path>` when the result is not the root or below it.
  Unlike session paths, a `..` that stays below the root is accepted.
- **Outcomes.** `listSandboxDirectory` and `listSandboxTree` check, in order:
  `escaped`, then `invalid_exclude` (both before any command runs), then
  `missing` (the path does not exist) or `not_directory`, then
  `excluded_root` (an `exclude` pattern matches the listed directory's own
  name).
- **`.git`.** `.git` directories are never entered.
- **Hidden entries.** An entry is hidden when any segment of its path below the
  listed directory starts with `.`, except `.agents`.
- **Default ignores.** `node_modules/` and `__pycache__/` are ignored as rules
  of the workspace root placed before every `.gitignore`, so a negation such as
  `!node_modules/` in a `.gitignore` brings them back.
- **`.gitignore` files.** The rules of every `.gitignore` from the workspace
  root down to the listed directory apply, then (in a recursive listing) every
  `.gitignore` found at or below the listed directory, sorted by full path
  with plain string comparison. The listed directory's own `.gitignore` is
  therefore read twice, once with the ancestors and once among the subtree
  files, where it takes its sorted place (after a sibling directory whose name
  sorts before `.`, such as one starting with `-`). `listSandboxDirectories`
  reads the same rule files in the same order. Each line is trimmed; blank lines and
  lines starting with `#` are skipped; `!` negates; a trailing `/` limits the
  rule to directories. A rule applies to the directory holding its file and
  everything below it, and matches the entry's path relative to that directory
  or the entry's name. Of the rules that match, the last one decides. A
  directory below the listed directory that is ignored hides everything below
  it, whatever later rules say; the rules are not applied to the listed
  directory itself or its ancestors.
- **Patterns.** In `.gitignore` rules and `exclude` patterns, `*` matches any
  characters but `/`, `?` one character but `/`, and `**` any characters. A
  leading `/` is not an anchor, so such a rule never matches. A rule with `[`
  or `]` matches only by equal text; an `exclude` pattern with them fails the
  listing with `invalid_exclude` and
  `Error: invalid exclude pattern '<pattern>': unclosed character class` (or
  `unsupported character classes`). `exclude` matches an entry's name or its
  absolute path, and an excluded directory hides its subtree.
- **Order.** Directories first, then files, each by name with an
  accent-sensitive, case-insensitive comparison in the host's default locale
  (`Intl.Collator(undefined, …)`); names that compare equal keep
  workspace-path order.

### Side effects and cost

The helpers only read. `listSandboxDirectory` and `listSandboxTree` run two
`sh` commands with `cwd` at the root: one that streams every `.gitignore` and,
in a recursive listing, the directory list; then one `find` scan. Only a
recursive scan prunes invisible directories (up to 32,768 characters of prune
arguments; directories past that budget are filtered after the scan).
`listSandboxDirectory` then runs the `wc -c` batches, without a `cwd`
([`files.ts`](src/lib/files.ts)).

Command failures inside these scripts are not reported
([`files.ts`](src/lib/files.ts)):

- The exit code of the rules read is not checked. When it fails, the listing
  goes on with the default ignores only. In a recursive listing, when the
  `find` for nested `.gitignore` files exits non-zero (for example because one
  subdirectory is unreadable), every nested `.gitignore` is dropped and only
  the ancestors' rules apply.
- When a `find` of the entry scan exits non-zero, for the same reason, the
  scan prints no entries and the listing is `listed` and empty.

## Development

The Nx project `sandbox` has these targets:

```console
npx nx build sandbox      # compile src to dist (tsconfig.lib.json)
npx nx typecheck sandbox
npx nx test sandbox       # tsc -p tsconfig.spec.json, then node --test dist-tests/tests/*.test.js
```

The visibility tests run the helpers' real `sh` and `find` commands against a
temporary directory mapped to the workspace root
([`tests/fake-sandbox.ts`](tests/fake-sandbox.ts)). `test` is defined in
[`project.json`](project.json); `build` and `typecheck` are inferred by Nx
from the TypeScript configuration.
