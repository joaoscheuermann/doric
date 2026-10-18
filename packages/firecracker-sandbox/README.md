# Firecracker sandbox provider

`firecracker-sandbox` runs Doric's provider-neutral
[`sandbox`](../sandbox/README.md) contract in Firecracker microVMs on KVM.
Each sandbox is its own jailed virtual machine with its own kernel, disk and
private network, which gives a stronger isolation boundary than a shared-kernel
container. It has no Docker dependency or Docker socket access. Use it on a
prepared Linux host when agent workloads need VM-level isolation.

Part of [Doric](../../README.md).

## Highlights

- **One VM per sandbox.** A jailed Firecracker VM, a sparse writable
  OverlayFS disk, a private TAP network, a management SSH channel and
  generated keys for every sandbox.
- **Ordinary OCI images.** Public Linux/amd64 images are converted into cached,
  immutable ext4 base disks.
- **Strict preflight.** Provisioning refuses hosts that cannot uphold the
  isolation contract and names what is missing.
- **Self-cleaning.** Startup reconciliation and disposal clean up owned
  processes, disks, networking and keys.
- **Same API as Docker.** Swap providers without changing code that uses
  `createSandbox`.

## Usage

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

## Configuration

`createFirecrackerClient(options?)` accepts overrides for asset paths, the
network pool, cache size, readiness timeout, jailer IDs and transport.

| Option               | Default                                               |
| -------------------- | ----------------------------------------------------- |
| `paths`              | `DEFAULT_FIRECRACKER_PATHS` (below), merged per field |
| `networkPool`        | `10.231.0.0/16`                                       |
| `cacheLimitBytes`    | 20 GiB root filesystem cache                          |
| `readinessTimeoutMs` | `30000`                                               |
| `jailerUid`          | `0`                                                   |
| `jailerGid`          | `0`                                                   |
| `transport`          | Node HTTP over the Firecracker API socket             |

Default asset and state paths:

| Path          | Default                                 |
| ------------- | --------------------------------------- |
| `firecracker` | `/usr/local/bin/firecracker`            |
| `jailer`      | `/usr/local/bin/jailer`                 |
| `kernel`      | `/opt/doric/firecracker/vmlinux`        |
| `initramfs`   | `/opt/doric/firecracker/initramfs.cpio` |
| `dropbear`    | `/opt/doric/firecracker/dropbearmulti`  |
| `state`       | `/var/lib/doric/firecracker`            |
| `cache`       | `/var/cache/doric/firecracker`          |

The pinned versions are Firecracker and jailer 1.16.1
(`FIRECRACKER_VERSION`) and a Linux 6.18 guest kernel
(`GUEST_KERNEL_VERSION`).

## Host requirements

Provisioning performs a strict preflight (`preflightFirecrackerHost`). The
host must provide:

- Linux x86_64 with read/write KVM and TUN access;
- cgroup v2, IPv4 forwarding, and nftables with network-admin access;
- the pinned Firecracker, jailer, kernel, initramfs, and Dropbear assets at the
  configured paths;
- the OCI, ext4, mount, network, and SSH command-line tools checked by
  `preflightFirecrackerHost` (`skopeo`, `umoci`, `mkfs.ext4`, `debugfs`,
  `mount`, `umount`, `truncate`, `ip`, `ssh`, `ssh-keygen`);
- writable state and cache directories.

The `app/backend/doric-host` Firecracker Compose profile packages these
requirements for development and e2e use. It is a privileged harness, not a
production isolation boundary.

## Runtime behavior

- Public Linux/amd64 OCI images are converted into cached immutable ext4 base
  disks.
- Every sandbox gets its own sparse writable OverlayFS disk, jailed VM,
  private TAP network, management SSH channel, and generated keys.
- Startup reconciliation and disposal clean up owned processes, disks,
  networking, and keys.
- Nothing is kept after disposal: the provider does not persist a
  `workspace`, so every sandbox starts from its image.

## Development

```console
npx nx build firecracker-sandbox
npx nx typecheck firecracker-sandbox
npx nx test firecracker-sandbox
```

The e2e suite requires the prepared host described above:

```console
npx nx run firecracker-sandbox:e2e
```
