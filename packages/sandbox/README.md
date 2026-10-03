# sandbox

`sandbox` defines Doric's provider-neutral isolated workspace boundary. A
provider provisions the low-level runtime; `createSandbox` adds safe workspace,
Git, file, diff, SSH, and lifecycle helpers.

## Use

Choose a provider such as `docker` or `firecracker` and inject it:

```ts
import { createDockerClient } from 'docker';
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

Relative paths resolve below `/workspace` by default. File and command working
directories cannot escape the configured root. After `dispose`, all session
operations reject; disposal itself is idempotent.

`workspace` names a durable workspace the sandbox serves, and `createSandbox`
forwards it to `provider.provision(input)` unchanged. How those files outlive the
sandbox is the provider's decision; providers that keep nothing durable treat the
value as a name only. Without a `workspace`, the sandbox is scratch.

`cloneRepo` supports branches, exact commits, and token or basic Git
authentication, and remembers the cloned path used by `diff()`. Cloning a
remote repository requires an effective egress policy.

## Network policy

Networking defaults to `disabled`. Set `mode: 'egress'` explicitly and provide
IP-literal DNS servers when name resolution is needed. Private network access
must be allowlisted by CIDR, protocol, and ports. Enabling SSH also enables the
provider's egress path and therefore requires DNS configuration; SSH defaults
to a loopback bind and key-only root access.

Providers remain responsible for enforcing resource and network policy. See
the [`docker`](../docker/README.md) and
[`firecracker`](../firecracker/README.md) READMEs for host prerequisites and
provider-specific behavior.

## Implement a provider

Implement `SandboxProvider.provision(input)` and return a `SandboxRuntime` with
`exec`, byte-oriented file transfer, optional SSH access, and idempotent
disposal. Consume normalized `input.network`, the explicit CPU, memory, and
disk resource values, and `input.workspace` rather than adding provider policy
to this package.

## Development

```console
npx nx build sandbox
npx nx test sandbox
```
