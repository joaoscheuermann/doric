# sandbox

`sandbox` is the boundary between an AI agent and the machine it works on.
It defines one provider-neutral contract for an isolated workspace, so the
same agent code runs on a Docker container or a Firecracker microVM without
change. A provider supplies the low-level runtime; `createSandbox` adds the
safe workspace, Git, file, diff, SSH and lifecycle helpers on top. Use it when
you want to run untrusted or agent-driven commands somewhere other than your
own machine.

Part of [Doric](../../README.md).

## Highlights

- **One contract, several backends.** Inject
  [`docker-sandbox`](../docker-sandbox/README.md),
  [`firecracker-sandbox`](../firecracker-sandbox/README.md) or your own
  `SandboxProvider`.
- **Confined paths.** Relative paths resolve below `/workspace` by default,
  and file paths and command working directories cannot escape the root.
- **Network off by default.** Egress, DNS, private-network exceptions and SSH
  are explicit, validated policy.
- **Git built in.** `cloneRepo` handles branches, exact commits and token or
  basic authentication; `diff` reports changes in the cloned repository.
- **Durable or scratch.** Name a `workspace` to let the provider keep files
  across sandboxes, or leave it out for a throwaway one.
- **Workspace visibility helpers.** List directories, trees and Git
  repositories with the same `.gitignore`-aware rules Doric's file views use.

## Usage

Choose a provider and inject it:

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
  const result = await sandbox.exec({
    cmd: ['cat', 'notes/todo.md'],
  });
  console.log(result.stdout);
} finally {
  await sandbox.dispose();
}
```

## API

### `createSandbox(options)`

Validates `resources` (each value a positive integer), provisions a runtime
through `options.provider` and returns a `SandboxSession`.

| Option            | Notes                                                 |
| ----------------- | ----------------------------------------------------- |
| `provider`        | The `SandboxProvider` that provisions the runtime.    |
| `image`           | The OCI image to run.                                 |
| `imagePullPolicy` | `'always'` or `'if-not-present'`.                     |
| `resources`       | `{ cpuCount, memoryMiB, diskMiB }`.                   |
| `network`         | A `SandboxNetworkPolicy`; `disabled` when omitted.    |
| `workspace`       | The durable workspace it serves; scratch when absent. |
| `root`            | Absolute workspace root; `/workspace` by default.     |
| `name`            | Optional sandbox name passed to the provider.         |
| `timeoutMs`       | Optional provisioning timeout passed to the provider. |

### Session methods

| Method                   | Behavior                                                                |
| ------------------------ | ----------------------------------------------------------------------- |
| `exec(input)`            | Runs a command; `cwd` resolves below the root.                          |
| `start(input)`           | Starts a live process (stdin, resize, terminate) when the provider can. |
| `readFile` / `writeFile` | UTF-8 text; `writeFile` creates missing parent directories.             |
| `getFile` / `putFile`    | The same operations on raw bytes.                                       |
| `cloneRepo(input)`       | Clones into `repo` (or `directory`) and returns its path and commit.    |
| `diff({ cwd?, paths? })` | `git diff` in `cwd`, else the cloned repository, else the root.         |
| `ssh()`                  | SSH access details, or `undefined` when SSH is not enabled.             |
| `stats()`                | A resource reading, or `undefined` when the provider offers none.       |
| `dispose()`              | Releases the runtime; idempotent.                                       |

After `dispose`, every other session operation fails.

### Other exports

- `normalizeSandboxNetwork(policy)` validates a policy and returns the
  effective provider-facing one.
- `listSandboxDirectory`, `listSandboxTree`, `listSandboxRepos` and
  `workspacePathKind` read a workspace through any `SandboxReader`. They apply
  root confinement, scoped `.gitignore` rules with negation, ignore
  `node_modules` and `__pycache__` unless a `.gitignore` negation reopens them,
  hide dot entries except `.agents`, and order directories first.
- `createVmRegistry(name, provider)` wraps a provider and tracks its running
  runtimes until their disposal completes.
- `captureProcessOutput`, `processTerminationScript` and `quote` are shared
  helpers for provider process transports.

## Behavior

### Workspaces

`workspace` names a durable workspace the sandbox serves, and `createSandbox`
forwards it to `provider.provision(input)` unchanged. How those files outlive
the sandbox is the provider's decision; providers that keep nothing durable
treat the value as a name only. Without a `workspace`, the sandbox is scratch.

### Git

`cloneRepo` supports branches, exact commits, and token or basic Git
authentication, and remembers the cloned path used by `diff()`. Cloning a
remote repository requires an effective egress policy.

### Network policy

- Networking defaults to `disabled`.
- Set `mode: 'egress'` explicitly and provide IPv4-literal `dnsServers`;
  effective egress without a DNS server is rejected.
- Private network access must be allowlisted by IPv4 CIDR, protocol (`tcp` or
  `udp`) and ports.
- Enabling SSH also enables the provider's egress path and therefore requires
  DNS configuration. SSH defaults to a loopback bind (`127.0.0.1`) and
  key-only root access; a non-loopback `bindAddress` requires an
  `advertisedHost`.

Providers remain responsible for enforcing resource and network policy. See
the [`docker-sandbox`](../docker-sandbox/README.md) and
[`firecracker-sandbox`](../firecracker-sandbox/README.md) READMEs for host
prerequisites and provider-specific behavior.

## Implement a provider

Implement `SandboxProvider.provision(input)` and return a `SandboxRuntime`
with `exec`, byte-oriented file transfer (`putFile`, `getFile`), SSH access
(`ssh()`, answering `undefined` when disabled) and idempotent `dispose`.
`start` (live processes) and `stats` (resource readings) are optional.
Consume the normalized `input.network`, the explicit CPU, memory and disk
resource values, and `input.workspace` rather than adding provider policy to
this package.

## Development

```console
npx nx build sandbox
npx nx typecheck sandbox
npx nx test sandbox
```
