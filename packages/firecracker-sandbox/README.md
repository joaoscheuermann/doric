# Firecracker sandbox provider

`firecracker-sandbox` implements the provider-neutral `sandbox` contract directly on
Firecracker/KVM. It has no Docker dependency or Docker socket access.

## Use

On a prepared Linux x86_64 host:

```ts
import { createFirecrackerClient } from 'firecracker-sandbox';
import { createSandbox } from 'sandbox';

const sandbox = await createSandbox({
  provider: createFirecrackerClient(),
  image: 'node:22-bookworm',
  imagePullPolicy: 'if-not-present',
  resources: { cpuCount: 2, memoryMiB: 2048, diskMiB: 4096 },
  network: { mode: 'disabled' },
});

try {
  const result = await sandbox.exec({ cmd: ['node', '--version'] });
  console.log(result.stdout);
} finally {
  await sandbox.dispose();
}
```

`createFirecrackerClient` accepts overrides for asset paths, the network pool,
cache size, readiness timeout, jailer IDs, and transport. Defaults use
Firecracker and jailer 1.16.1, a Linux 6.18 guest kernel, a `10.231.0.0/16`
network pool, and a 20 GiB root filesystem cache.

## Host requirements

Provisioning performs a strict preflight. The host must provide:

- Linux x86_64 with read/write KVM and TUN access;
- cgroup v2, IPv4 forwarding, and nftables with network-admin access;
- the pinned Firecracker, jailer, kernel, initramfs, and Dropbear assets at the
  configured paths;
- the OCI, ext4, mount, network, and SSH command-line tools checked by
  `preflightFirecrackerHost`;
- writable state and cache directories.

The `app/backend/doric-host` Firecracker Compose profile packages these requirements for
development and e2e use. It is a privileged harness, not a production
isolation boundary.

## Runtime behavior

Public Linux/amd64 OCI images are converted into cached immutable ext4 base
disks. Every sandbox gets its own sparse writable OverlayFS disk, jailed VM,
private TAP network, management SSH channel, and generated keys. Startup
reconciliation and disposal clean up owned processes, disks, networking, and
keys.

## Development

```console
npx nx build firecracker-sandbox
npx nx test firecracker-sandbox
```

The e2e suite requires the prepared host described above:

```console
npx nx run firecracker-sandbox:e2e
```
