# firecracker-sandbox

`firecracker-sandbox` is a provider of the [`sandbox`](../sandbox/README.md)
contract that runs each sandbox in its own Firecracker microVM on KVM. A
sandbox gets its own guest kernel, a read-only base disk converted from an OCI
image, a writable overlay disk, a private `/30` network on its own TAP device
and a management SSH channel. The package needs no Docker daemon and no Docker
socket. It runs on a prepared Linux x86_64 host.

Part of [Doric](../../README.md). The [sandboxes feature](../../docs/features/sandboxes.md)
describes how the host, the pool and the runtime use sandboxes; this README is
the home of the package's exports and behavior.

## Who uses it

- The bundle [`firecracker`](../../bundles/sandboxes/firecracker/README.md)
  builds its client with `createFirecrackerClient()`, wraps it with
  `createVmRegistry('firecracker', client)` of `sandbox`, and hands that to
  `createSandbox` through its sandbox pool
  ([`sandbox.ts`](../../bundles/sandboxes/firecracker/src/host/sandbox.ts)).
- The host image of [`doric-host`](../../app/backend/doric-host/README.md)
  installs the binaries, the guest kernel, the initramfs and the guest scripts
  this package expects at its default paths
  ([`.Dockerfile`](../../app/backend/doric-host/.Dockerfile)).
- The package's own e2e suite ([`sandbox.e2e.ts`](tests/sandbox.e2e.ts)).

## Usage

```ts
import { createFirecrackerClient } from 'firecracker-sandbox';
import { createSandbox } from 'sandbox';

const sandbox = await createSandbox({
  provider: createFirecrackerClient(),
  image: 'node:22-bookworm',
  imagePullPolicy: 'if-not-present',
  resources: { cpuCount: 2, memoryMiB: 2048, diskMiB: 4096 },
  network: { mode: 'egress', dnsServers: ['1.1.1.1'] },
});

try {
  const result = await sandbox.exec({ cmd: ['node', '--version'] });
  console.log(result.stdout);
} finally {
  await sandbox.dispose();
}
```

`createSandbox` validates the resources and the network policy and calls the
provider's `provision`; the [`sandbox` README](../sandbox/README.md) describes
the session it returns.

## Entry point and exports

`package.json` exports one entry, `.`, built to `dist/index.js` with its types
in `dist/index.d.ts` (the condition `@org/source` resolves to
`src/index.ts` inside the monorepo) ([`package.json`](package.json),
[`index.ts`](src/index.ts)). Its runtime dependencies are `sandbox` and
`tslib`.

| Export                           | Kind      | Defined in                                 |
| -------------------------------- | --------- | ------------------------------------------ |
| `createFirecrackerClient`        | function  | [`firecracker.ts`](src/lib/firecracker.ts) |
| `DEFAULT_FIRECRACKER_PATHS`      | constant  | [`firecracker.ts`](src/lib/firecracker.ts) |
| `FIRECRACKER_VERSION`            | constant  | [`firecracker.ts`](src/lib/firecracker.ts) |
| `GUEST_KERNEL_VERSION`           | constant  | [`firecracker.ts`](src/lib/firecracker.ts) |
| `preflightFirecrackerHost`       | function  | [`preflight.ts`](src/lib/preflight.ts)     |
| `createFirecrackerApi`           | function  | [`api.ts`](src/lib/api.ts)                 |
| `nodeTransport`                  | function  | [`api.ts`](src/lib/api.ts)                 |
| `prepareImage`                   | function  | [`image.ts`](src/lib/image.ts)             |
| `PreparedImage`                  | interface | [`image.ts`](src/lib/image.ts)             |
| `createVmNetwork`                | function  | [`network.ts`](src/lib/network.ts)         |
| `renderFirecrackerNetworkRules`  | function  | [`network.ts`](src/lib/network.ts)         |
| `VmNetwork`                      | interface | [`network.ts`](src/lib/network.ts)         |
| `CreateFirecrackerClientOptions` | interface | [`types.ts`](src/lib/types.ts)             |
| `FirecrackerConfig`              | interface | [`types.ts`](src/lib/types.ts)             |
| `FirecrackerPaths`               | interface | [`types.ts`](src/lib/types.ts)             |
| `FirecrackerApi`                 | interface | [`types.ts`](src/lib/types.ts)             |
| `FirecrackerRequest`             | interface | [`types.ts`](src/lib/types.ts)             |
| `FirecrackerResponse`            | interface | [`types.ts`](src/lib/types.ts)             |
| `FirecrackerTransport`           | type      | [`types.ts`](src/lib/types.ts)             |

The VM lifecycle ([`runtime.ts`](src/lib/runtime.ts)), the writable disk
([`disk.ts`](src/lib/disk.ts)), SSH ([`ssh.ts`](src/lib/ssh.ts)), live
processes ([`process.ts`](src/lib/process.ts)), guest statistics
([`stats.ts`](src/lib/stats.ts)), reconciliation
([`reconcile.ts`](src/lib/reconcile.ts)) and the host command runner
([`command.ts`](src/lib/command.ts)) are internal and not exported.

### `createFirecrackerClient(options?)`

```ts
function createFirecrackerClient(
  options?: CreateFirecrackerClientOptions,
): SandboxProvider;

interface CreateFirecrackerClientOptions {
  readonly paths?: Partial<FirecrackerPaths>;
  readonly networkPool?: string;
  readonly cacheLimitBytes?: number;
  readonly readinessTimeoutMs?: number;
  readonly jailerUid?: number;
  readonly jailerGid?: number;
  readonly transport?: FirecrackerTransport;
  readonly preflight?: (config: FirecrackerConfig) => Promise<void>;
  readonly provision?: (
    input: SandboxProvisionInput,
    config: FirecrackerConfig,
  ) => Promise<SandboxRuntime>;
}
```

It builds a `FirecrackerConfig` from the options and returns a
`SandboxProvider` whose `provision(input)` runs, in order
([`firecracker.ts`](src/lib/firecracker.ts)):

1. the preflight, on every call;
2. the reconciliation of stale resources, once per client: the first call
   starts it and every later call awaits the same promise, so a
   reconciliation that rejects makes every provisioning of that client reject;
3. the provisioning of one microVM.

| Option               | Default                                                                 | Meaning                                                              |
| -------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `paths`              | `DEFAULT_FIRECRACKER_PATHS`, merged field by field                      | Binaries, guest assets, state and cache directories                  |
| `networkPool`        | `'10.231.0.0/16'`                                                       | IPv4 pool the `/30` sandbox networks are cut from                    |
| `cacheLimitBytes`    | `20 * 1024 ** 3` (20 GiB)                                               | Bound of the base-disk cache                                         |
| `readinessTimeoutMs` | `30000`                                                                 | Bound of each readiness wait (jail root, API socket, guest SSH)      |
| `jailerUid`          | `0`                                                                     | User the jailer runs Firecracker as                                  |
| `jailerGid`          | `0`                                                                     | Group the jailer runs Firecracker as                                 |
| `transport`          | `nodeTransport`                                                         | How requests reach the Firecracker API socket                        |
| `preflight`          | `preflightFirecrackerHost`                                              | Host check run before each provisioning                              |
| `provision`          | the package's microVM provisioning ([`runtime.ts`](src/lib/runtime.ts)) | Builds one runtime; a test seam that replaces the whole VM lifecycle |

`FirecrackerConfig` holds the resolved values of the first seven options, all
required ([`types.ts`](src/lib/types.ts)).

The base name of `paths.firecracker` must be `firecracker`. The jailer builds
its chroot at `<chroot base>/<base name of --exec-file>/<id>/root`, while the
provisioning and the reconciliation look for it at
`<state>/jailer/firecracker/<id>/root`; with any other base name the jail root
never appears where it is awaited, and provisioning fails with
`Firecracker jailer readiness timed out` ([`runtime.ts`](src/lib/runtime.ts),
[`reconcile.ts`](src/lib/reconcile.ts)).

### Constants

```ts
const FIRECRACKER_VERSION = '1.16.1';
const GUEST_KERNEL_VERSION = '6.18';
const DEFAULT_FIRECRACKER_PATHS: FirecrackerPaths;

interface FirecrackerPaths {
  readonly firecracker: string;
  readonly jailer: string;
  readonly kernel: string;
  readonly initramfs: string;
  readonly dropbear: string;
  readonly state: string;
  readonly cache: string;
}
```

| Path          | Default                                 | What it is                                     |
| ------------- | --------------------------------------- | ---------------------------------------------- |
| `firecracker` | `/usr/local/bin/firecracker`            | Firecracker VMM binary                         |
| `jailer`      | `/usr/local/bin/jailer`                 | Firecracker jailer binary                      |
| `kernel`      | `/opt/doric/firecracker/vmlinux`        | Uncompressed guest kernel                      |
| `initramfs`   | `/opt/doric/firecracker/initramfs.cpio` | Guest initramfs (see [The guest](#the-guest))  |
| `dropbear`    | `/opt/doric/firecracker/dropbearmulti`  | Dropbear multi-call binary, used for host keys |
| `state`       | `/var/lib/doric/firecracker`            | Per-sandbox state, jails and network records   |
| `cache`       | `/var/cache/doric/firecracker`          | Base-disk cache                                |

The two version constants name the pinned versions
([`firecracker.ts`](src/lib/firecracker.ts)). The preflight checks that the
Firecracker and jailer version output contains the literal `1.16.1`
([`preflight.ts`](src/lib/preflight.ts)); no code checks the guest kernel
version.

### `preflightFirecrackerHost(config)`

```ts
function preflightFirecrackerHost(config: FirecrackerConfig): Promise<void>;
```

It resolves when the host can run sandboxes and otherwise rejects with an
`Error` naming the first missing requirement
([`preflight.ts`](src/lib/preflight.ts)):

| Requirement                                                                                                                                                         | Message when missing                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `process.platform` is `linux`                                                                                                                                       | `Firecracker requires a Linux host`                                                                     |
| `process.arch` is `x64`                                                                                                                                             | `Firecracker requires an x86_64 host`                                                                   |
| Read/write access to `/dev/kvm` and `/dev/net/tun`                                                                                                                  | `Firecracker preflight requires read/write KVM access: /dev/kvm` (and likewise `read/write TUN access`) |
| Read access to `/sys/fs/cgroup/cgroup.controllers` (cgroup v2)                                                                                                      | `Firecracker preflight requires cgroup v2: <path>`                                                      |
| Executable `firecracker`, `jailer` and `dropbear` paths; readable `kernel` and `initramfs`; read/write `state` and `cache`                                          | `Firecracker preflight requires <capability>: <path>`                                                   |
| An executable `nft` at `/usr/sbin/nft`, `/usr/bin/nft` or `/sbin/nft` whose `nft list ruleset` succeeds                                                             | `Firecracker preflight requires the nftables executable`                                                |
| `/proc/sys/net/ipv4/ip_forward` is `1`                                                                                                                              | `Firecracker preflight requires IPv4 forwarding`                                                        |
| `firecracker --version` and `jailer --version` output containing `1.16.1`                                                                                           | `Firecracker preflight requires Firecracker v1.16.1` / `jailer v1.16.1`                                 |
| `debugfs`, `ip`, `mkfs.ext4`, `mount`, `skopeo`, `ssh`, `ssh-keygen`, `truncate`, `umoci`, `umount` in `/usr/local/bin`, `/usr/sbin`, `/usr/bin`, `/sbin` or `/bin` | `Firecracker preflight requires host command: <command>`                                                |

The capabilities are `Firecracker binary`, `Firecracker jailer`,
`guest kernel`, `guest initramfs`, `Dropbear key tool`, `state directory` and
`rootfs cache directory`. The checks after the platform and architecture run
concurrently, so the error is that of the first check to fail. An `nft` that is
found but cannot list the ruleset yields the same message as a missing one.
When a version command itself fails, the error is the command runner's
`Firecracker host command failed: <binary>` ([`command.ts`](src/lib/command.ts)).
The other host commands are run by name, through `PATH`.

### `createFirecrackerApi(socketPath, transport?)` and `nodeTransport`

```ts
function createFirecrackerApi(
  socketPath: string,
  transport?: FirecrackerTransport, // default: nodeTransport
): FirecrackerApi;

interface FirecrackerApi {
  request(input: FirecrackerRequest): Promise<void>;
  configure(input: {
    readonly cpuCount: number;
    readonly memoryMiB: number;
    readonly kernel: string;
    readonly initramfs: string;
    readonly baseDisk: string;
    readonly writableDisk: string;
    readonly tap: string;
    readonly guestMac: string;
  }): Promise<void>;
  start(signal?: AbortSignal): Promise<void>;
}

interface FirecrackerRequest {
  readonly method: 'GET' | 'PUT' | 'PATCH';
  readonly path: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

interface FirecrackerResponse {
  readonly status: number;
  readonly body: Uint8Array;
}

type FirecrackerTransport = (
  socketPath: string,
  request: FirecrackerRequest,
) => Promise<FirecrackerResponse>;
```

`request` sends one request through the transport and rejects with
`Firecracker API <method> <path> failed with status <status>` for any status
outside 200–299; the response body is never included in the error
([`api.ts`](src/lib/api.ts)).

`configure` sends, in this order, each as a `PUT`
([`api.ts`](src/lib/api.ts)):

| Path                       | Body                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `/boot-source`             | `kernel_image_path`, `initrd_path`, `boot_args: 'console=ttyS0 reboot=k panic=1 pci=off ipv6.disable=1'` |
| `/machine-config`          | `vcpu_count`, `mem_size_mib`, `smt: false`, `track_dirty_pages: false`                                   |
| `/drives/base`             | `drive_id: 'base'`, `path_on_host: baseDisk`, `is_root_device: false`, `is_read_only: true`              |
| `/drives/writable`         | `drive_id: 'writable'`, `path_on_host: writableDisk`, `is_root_device: false`, `is_read_only: false`     |
| `/entropy`                 | `{}`                                                                                                     |
| `/network-interfaces/eth0` | `iface_id: 'eth0'`, `host_dev_name: tap`, `guest_mac: guestMac`                                          |

`start(signal?)` sends `PUT /actions` with `{ action_type: 'InstanceStart' }`.

`nodeTransport` sends the request with `node:http` over the Unix socket,
serializes a defined `body` as JSON with `content-type: application/json` and
`content-length`, and resolves with the status (`0` when absent) and the whole
response body. An aborted `signal` destroys the request with an error named
`AbortError` (`Firecracker API request aborted`). It sets no timeout
([`api.ts`](src/lib/api.ts)).

### `prepareImage(image, sandboxId, config, signal?, pullPolicy?)`

```ts
function prepareImage(
  image: string,
  sandboxId: string,
  config: FirecrackerConfig,
  signal?: AbortSignal,
  pullPolicy?: 'always' | 'if-not-present', // default: 'always'
): Promise<PreparedImage>;

interface PreparedImage {
  readonly disk: string; // path of the cached ext4 base disk
  readonly digest: string; // manifest digest, sha256:<hex>
  readonly env: readonly string[]; // the image's Env, KEY=VALUE
  readonly user: string; // the image's User, '' when unset
  release(): Promise<void>; // removes this sandbox's use marker
}
```

It turns a public OCI reference into a cached, immutable ext4 disk and marks it
as used by `sandboxId` ([`image.ts`](src/lib/image.ts)):

1. The reference must be non-empty, without `://` and without whitespace, or it
   rejects with `Firecracker image must be a public OCI registry reference`
   before any tool runs.
2. With `if-not-present`, a cached entry recorded for the same reference is
   activated and returned without running any image tool. With `always`, or
   when no usable entry exists, it goes on.
3. `skopeo copy --override-os linux --override-arch amd64 docker://<image> oci:<layout>:doric`
   copies the image into the temporary layout `<cache>/.acquire-<random>/oci`.
   It passes no credentials option, so `skopeo` uses whatever its default
   registry auth file holds. The first manifest of the layout's `index.json` must carry a
   `sha256:` digest, or it rejects with
   `OCI copy did not produce one valid linux/amd64 manifest`.
4. The cache key is the SHA-256 of `<digest>:oci-ext4-v1`. Under the key's
   lock, when the disk or its metadata is missing, it converts the image:
   - `skopeo inspect --config` must report `os: linux` and
     `architecture: amd64`, or it rejects with
     `OCI image platform must be linux/amd64`; the `Env` strings and the `User`
     are kept as metadata;
   - `umoci unpack` extracts the root filesystem, which must hold only
     directories, regular files and symbolic links that resolve inside it
     (`OCI image contains an escaping symbolic link`,
     `OCI image contains an unsupported special file`);
   - the disk size is the larger of 512 MiB and 1.3 × the files' total size
     plus 64 MiB; a size above `cacheLimitBytes` rejects with
     `OCI image cannot fit in the Firecracker rootfs cache`;
   - `truncate` and `mkfs.ext4 -F -q -d <rootfs>` build the disk, which is
     made mode `0400` and renamed into place, then the metadata is written.
5. The reference record is written, and the entry is activated: under the
   cache-wide LRU lock, a use marker for `sandboxId` is written, the disk's
   modification time is set to now, and the cache is evicted down to
   `cacheLimitBytes`. A missing entry at that point rejects with
   `Firecracker image cache publication failed`.

Eviction removes disks oldest modification time first, skipping every disk
with a use marker; if the cache still exceeds the limit it rejects with
`Firecracker rootfs cache is full with in-use images`. The cache size is the
sum of the sizes of `<cache>/images/*.ext4` only; metadata, reference records,
use markers and temporaries are not counted. Metadata whose fields have the
wrong types rejects with `Firecracker image cache metadata is invalid`;
metadata that is not JSON rejects with the `SyntaxError` of `JSON.parse`. A failing tool
rejects with the command runner's error. The temporary layout is always
removed.

Locks are directories created with `mkdir`; a waiter retries every 50 ms until
the lock is free or `signal` aborts (an error named `AbortError`).

### `createVmNetwork(id, policy, config, signal?)` and `renderFirecrackerNetworkRules(table, tap, policy)`

```ts
function createVmNetwork(
  id: string,
  policy: NormalizedSandboxNetworkPolicy,
  config: FirecrackerConfig,
  signal?: AbortSignal,
): Promise<VmNetwork>;

interface VmNetwork {
  readonly tap: string; // doric<first 10 hex chars of id>
  readonly host: string; // host address of the /30, the guest's gateway
  readonly guest: string; // guest address of the /30
  readonly guestCidr: string; // <guest>/30
  readonly mac: string; // 06:fc:<index as four bytes>
  readonly table: string; // doric_<first 12 hex chars of id>
  dispose(): Promise<void>;
}

function renderFirecrackerNetworkRules(
  table: string,
  tap: string,
  policy: NormalizedSandboxNetworkPolicy,
): string;
```

`createVmNetwork` ([`network.ts`](src/lib/network.ts)):

1. Validates `networkPool`: a dotted IPv4 network address with a prefix from
   `/16` to `/30`, or it rejects with
   `Firecracker networkPool must be an IPv4 /16 through /30 CIDR` or
   `Firecracker networkPool must use its network address`.
2. Under the lock `<state>/.network-lock` (retried every 25 ms), takes the
   lowest `/30` index not recorded in `<state>/networks/` and records it in
   `<state>/networks/<id>`. The pool holds `2^(30 - prefix)` networks; when all
   are taken it rejects with `Firecracker VM network pool is exhausted`.
   Index `n` gives the host address `base + 4n + 1` and the guest
   `base + 4n + 2`.
3. Runs `ip tuntap add dev <tap> mode tap`, `ip addr add <host>/30 dev <tap>`,
   `ip link set <tap> up`, and loads the rendered rules with `nft -f -`.

On a failure it removes what it made (rules, TAP, record) and rethrows.
`dispose()` deletes the tables, the TAP and the record, and rejects with an
`AggregateError` `Firecracker network cleanup failed` when any step fails; a
later call retries the failed steps, and a call after success does nothing.

`renderFirecrackerNetworkRules` returns an nftables script
([`network.ts`](src/lib/network.ts)):

- table `inet <table>`, chain `input` (hook input, priority 0, policy accept):
  traffic from the TAP is accepted only when established or related, so the
  guest cannot open connections to the host;
- chain `forward` (hook forward, priority 0, policy accept): traffic to the
  TAP that is established or related is accepted; traffic from the TAP is
  then, with `mode: 'disabled'`, dropped; with `mode: 'egress'`:
  1. accepted to each `allowPrivate` exception
     (`ip daddr <cidr> <protocol> dport { <ports> }`);
  2. dropped to the protected ranges `0.0.0.0/8`, `10.0.0.0/8`,
     `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`,
     `192.0.0.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `224.0.0.0/4`,
     `240.0.0.0/4`;
  3. accepted to each `dnsServers` entry on UDP and TCP port 53, which a DNS
     server inside a protected range never reaches;
  4. accepted otherwise;
- with `mode: 'egress'`, a table `ip <table>_nat` whose `postrouting` chain
  masquerades traffic from the TAP.

No rule filters new traffic towards the TAP: in either mode it reaches the
forward chain's `policy accept`, so inbound connections to the guest from
wherever the host routes them are not filtered.

## Provisioning a sandbox

`provision(input)` with the default `provision` builds one microVM from the
fields `image`, `imagePullPolicy` (default `'always'`), `resources`, `network`
and `timeoutMs` of `SandboxProvisionInput`; it ignores `name`, `workspace` and
`root` ([`runtime.ts`](src/lib/runtime.ts)). Each sandbox gets a fresh UUID as
its id. The steps, in order ([`runtime.ts`](src/lib/runtime.ts)):

1. Create `<state>/sandboxes/<id>/` (mode `0700`) and its `keys/`, and generate
   three Ed25519 key pairs: a management key and a user key with `ssh-keygen`,
   and a host key with `dropbearkey` from the `dropbear` binary, whose SHA-256
   fingerprint comes from `ssh-keygen -E sha256 -lf`
   ([`ssh.ts`](src/lib/ssh.ts)). Failures reject with
   `Could not derive Firecracker SSH host public key` or
   `Could not fingerprint Firecracker SSH host key`.
2. Prepare the base disk with `prepareImage`.
3. Create the network with `createVmNetwork`.
4. Create the writable disk `<state>/sandboxes/<id>/writable.ext4`: a sparse
   file of `diskMiB` MiB formatted with `mkfs.ext4`, into which `debugfs -w`
   creates `/config`, `/upper` and `/work` and writes the files of
   `/config` ([`disk.ts`](src/lib/disk.ts)):

   | File                | Content                                   |
   | ------------------- | ----------------------------------------- |
   | `authorized_keys`   | The management and the user public keys   |
   | `dropbear_host_key` | The Dropbear host private key             |
   | `guest_cidr`        | `<guest>/30`                              |
   | `gateway`           | The host address of the `/30`             |
   | `resolv.conf`       | One `nameserver <ip>` line per DNS server |

5. Launch the jailer, with its output discarded:

   ```console
   <jailer> --id <id> --exec-file <firecracker> --uid <jailerUid> \
     --gid <jailerGid> --chroot-base-dir <state>/jailer --cgroup-version 2 \
     -- --api-sock /api.socket
   ```

   Its jail root is `<state>/jailer/firecracker/<id>/root`.

6. Wait for the jail root, copy the kernel to `vmlinux` and the initramfs to
   `initramfs.cpio` in it (mode `0400`), bind-mount the base disk read-only at
   `base.ext4`, and move the writable disk to `writable.ext4`.
7. Wait for `api.socket`, then `configure` with the jail-relative paths
   `/vmlinux`, `/initramfs.cpio`, `/base.ext4` and `/writable.ext4`, the
   resources' `cpuCount` and `memoryMiB`, the TAP and the MAC.
8. Write `<state>/sandboxes/<id>/state.json` (mode `0600`) with `id`, `pid`,
   `tap`, `table`, `jailDirectory` and `baseMounted`, then `start` the VM.
9. Write `known_hosts` with the guest's host key on port 22 and wait until the
   management channel runs `true` with exit code 0 (each try bounded to 1 s,
   tried every 100 ms).
10. When the policy enables SSH, open the user SSH proxy.

Each wait in steps 6, 7 and 9 is bounded by `readinessTimeoutMs`. A jailer that
exits with an exit code during the waits of steps 6 and 7 rejects with
`Firecracker jailer exited before readiness`; a jailer ended by a signal has no
exit code, so the wait goes on until it times out. A timeout rejects with
`Firecracker jailer readiness timed out` or
`Firecracker guest readiness timed out`. On any failure the provisioning
disposes of what it made, with the same steps as `dispose()`, ignores cleanup
errors and rethrows the error that stopped it. When the jailer has already
ended by a signal, that disposal never settles (see [Disposal](#disposal)), so
the provisioning never settles either.

### The guest

The initramfs comes from the host image, not from this package. Its
[`init`](../../app/backend/doric-host/firecracker/init) mounts the first drive
(`/dev/vda`, the base disk) read-only and the second (`/dev/vdb`, the writable
disk), overlays the base with `upper` and `work` of the writable disk, copies
BusyBox and Dropbear to `/.doric/bin/` (with `/.doric/bin/sh`), binds
`/config` at `/doric-config` and switches root.
[`guest-start`](../../app/backend/doric-host/firecracker/guest-start)
creates `/workspace`, installs `authorized_keys` for `root`, configures
`eth0` from `guest_cidr` and `gateway`, copies `resolv.conf`, and runs Dropbear
in the foreground on port 22 with the given host key, with password logins
disabled (`-s -g`) and port forwarding disabled (`-j -k`). Only `/workspace` is
created; a session root elsewhere must already exist in the image.

The package relies on that layout: `/.doric/bin/busybox` for `env`, `su` and
file transfer, and `root` SSH login with the management key. Dropbear runs
every remote script with the login shell of `root` in the image's
`/etc/passwd`, so the image needs a `root` entry with a working shell. Every
command is found through the image's `PATH` ([`ssh.ts`](src/lib/ssh.ts),
[`process.ts`](src/lib/process.ts)):

| Operation                  | Commands the image must provide                               |
| -------------------------- | ------------------------------------------------------------- |
| `exec`                     | The command itself                                            |
| `start`                    | `sh`, and `setsid` without a TTY or `tty` and `stty` with one |
| Terminating a live process | `sh`, `sleep`, `cat`, `kill` and `rm`                         |
| `resize`                   | `sh`, `stty` and `cat`                                        |
| `stats()`                  | `cat`                                                         |

## The runtime

The `SandboxRuntime` a provisioning returns ([`runtime.ts`](src/lib/runtime.ts)):

| Member                 | Behavior                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | The sandbox's UUID                                                                                                                                |
| `exec(input)`          | Runs one command over the management channel and resolves with its result                                                                         |
| `start(input)`         | Starts a live process (see below)                                                                                                                 |
| `putFile(path, bytes)` | Writes the bytes through `/.doric/bin/busybox cat > <path>`; any non-zero exit, SSH's 255 included, rejects with `Firecracker file upload failed` |
| `getFile(path)`        | Reads through `/.doric/bin/busybox cat <path>`; any non-zero exit, SSH's 255 included, rejects with `Firecracker file download failed`            |
| `stats()`              | Reads the guest's CPU and memory (see below)                                                                                                      |
| `ssh()`                | Resolves with the user SSH access, or `undefined` when SSH is off                                                                                 |
| `dispose()`            | Releases every resource of the sandbox                                                                                                            |

### Commands

Every command is one `ssh` process to `root@<guest>` with
`-i <management key>`, `BatchMode=yes`, `IdentitiesOnly=yes`,
`StrictHostKeyChecking=yes`, the sandbox's own `UserKnownHostsFile` and
`ConnectTimeout=2`, `-T`, or `-tt` when `tty` is true
([`ssh.ts`](src/lib/ssh.ts)). The remote script is
`cd <cwd> && /.doric/bin/busybox env <env> <cmd>`, every word shell-quoted,
where `cwd` defaults to `/workspace` and `env` is the image's `Env` overlaid by
the input's `env` by variable name. The user is the input's `user`, else the
image's `User`; for any user other than `''`, `root`, `0` or `0:0`, the script
runs through `/.doric/bin/busybox su -s /.doric/bin/sh <name>`, where `<name>`
is the part before `:`. The env merge keeps only entries with a `=` after at
least one character; others are dropped.

`exec` resolves with `exitCode`, `stdout`, `stderr` and their bytes whenever
the local `ssh` process closes. SSH's own failures are results, not errors: an
unreachable guest or a host-key mismatch resolves with `exitCode` 255 and
SSH's message in `stderr`. `exitCode` is `null` only when the local `ssh`
process ends by a signal. An empty `cmd` throws
`Sandbox command must not be empty` synchronously. `timeoutMs` kills the SSH process and
rejects with `Sandbox command timed out`; an aborted `signal` kills it and
rejects with an error named `AbortError`. An SSH process that cannot start
rejects with `Firecracker management SSH could not start`.

`putFile` and `getFile` run the bare `busybox cat` as `root`, without the
image's `Env`, without changing directory and without a timeout, so the files
they write are owned by `root` ([`ssh.ts`](src/lib/ssh.ts)).

### Live processes

`start(input)` runs the command under `sh -c` that first writes its PID to
`/tmp/doric-process-<uuid>`; without a TTY it runs under `setsid -w`, and with a
TTY it records the terminal device in `<pid file>.tty` and sets its size to
`cols` × `rows` (80 × 24 by default) ([`process.ts`](src/lib/process.ts)).
Its env merge keys each entry by the text before its first `=`; an entry
without `=` is kept and passed to `busybox env`, which takes it as the command
to run. It resolves once the SSH process has spawned, with:

- `result`: resolves with the exit result when the SSH process closes. When
  SSH closes with code 255 or no code, the remote process may still run, so it
  is terminated first. When the termination succeeds or is not needed, the
  PID files are then removed; when it fails, `result` rejects with its error
  (`Could not terminate guest process`, or the error of the command that ran
  it, such as `Sandbox command timed out`) and the PID files stay, and a cause
  that is not an `Error` becomes `Guest process cleanup failed`. Output is
  collected and forwarded to `onOutput` by `captureProcessOutput` of
  [`sandbox`](../sandbox/README.md).
- `write(data)`: writes to the process's stdin; rejects with
  `Sandbox process has exited` after it ends.
- `resize(cols, rows)`: with a TTY, runs `stty` on the recorded terminal; it
  rejects with a `RangeError` `Terminal dimensions must be positive integers` for
  other values and rejects with `Could not resize guest terminal` when `stty`
  fails. Without a TTY or after the end it does nothing.
- `terminate()`: as `root`, bounded to 5 s, waits up to one second for the PID
  file; when none appears it resolves without killing anything. Otherwise
  `processTerminationScript` of `sandbox` sends `SIGKILL` to every process
  whose session id is the recorded PID and to that PID, and removes the PID
  file; the `.tty` file is removed too. A non-zero exit rejects with
  `Could not terminate guest process`. It runs once; later calls share it.

`timeoutMs` and an aborted `signal` call `terminate()`, and kill the SSH
process when termination fails. `start` rejects with the signal's reason when
the signal is already aborted, with `Sandbox command must not be empty` for an
empty `cmd`, and with the raw spawn error when `ssh` cannot be spawned.

### Statistics

`stats()` runs `cat /proc/stat /proc/meminfo` in the guest, bounded by the
provisioning's `timeoutMs` and unbounded without one ([`runtime.ts`](src/lib/runtime.ts),
[`stats.ts`](src/lib/stats.ts)). It resolves with:

- `cpuCount`: the provisioned `cpuCount`;
- `memoryUsedBytes`: `MemTotal − MemAvailable`, never below 0;
- `memoryLimitBytes`: `MemTotal`;
- `cpuPercent`: the busy share, 0–100, of the jiffies of the aggregate `cpu`
  line since the previous call (idle and iowait count as not busy). The first
  call has no previous sample and omits it, as does a call where the counters
  did not advance or went back, or where `/proc/stat` has no readable
  aggregate `cpu` line;
- `at`: the time of the reading, ISO 8601.

A non-zero exit or a missing `MemTotal` or `MemAvailable` rejects with
`Firecracker guest stats are unavailable`.

### User SSH

When the normalized policy's `ssh` is not `false`, the provider opens a TCP
server on `ssh.bindAddress` and `ssh.port` (an ephemeral port when absent) that
pipes every connection to port 22 of the guest ([`ssh.ts`](src/lib/ssh.ts)).
`ssh()` then resolves with `SandboxSshAccess`:

| Field                | Value                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| `host`               | `ssh.advertisedHost`, else the address the server listens on               |
| `port`               | The port the server listens on                                             |
| `username`           | `'root'`                                                                   |
| `privateKey`         | The user private key (OpenSSH format)                                      |
| `knownHosts`         | `<host> <type> <key>` on port 22, `[<host>]:<port> <type> <key>` otherwise |
| `hostKeyFingerprint` | The host key's `SHA256:` fingerprint                                       |

A server that does not get a TCP address rejects with
`Firecracker SSH proxy did not expose a TCP address`.

### Disposal

`dispose()` runs every step even when one fails, in this order: close the SSH
proxy; stop the jailer (`SIGTERM`, then `SIGKILL` after 2 s); unmount the base
disk; dispose of the network; remove the jail directory; remove
`<state>/sandboxes/<id>/`; release the image's use marker. Failures reject
with an `AggregateError` `Firecracker cleanup failed`. A later call runs the
disposal again; after one success, calls do nothing. The done flag is set only
after success, so concurrent calls each run the whole disposal. The stop step
returns at once only when the jailer has an exit code: when the jailer has
already ended by a signal, including the `SIGTERM` of an earlier disposal, the
step waits for an exit event that has already fired, sends `SIGKILL` after 2 s
and waits again, so that call never settles
([`runtime.ts`](src/lib/runtime.ts)). Nothing outlives a sandbox: the provider
keeps no workspace, and every sandbox starts from its image.

## Reconciliation

The first provisioning of a client removes the sandboxes a previous provider
process recorded under `<state>/sandboxes/`, and the locks
([`reconcile.ts`](src/lib/reconcile.ts)). It deletes `<state>/.network-lock`,
`<cache>/.lru-lock` and every lock under `<cache>/locks/`. For each directory
under `<state>/sandboxes/`, whether its VM still runs or not, it:

1. sends `SIGKILL` to the PID in its `state.json` and to every process whose
   `/proc/<pid>/cmdline` contains the sandbox id and `firecracker` or `jailer`;
2. unmounts `<jail root>/base.ext4`, deletes the nftables tables
   `inet doric_<…>` and `ip doric_<…>_nat` and the TAP `doric<…>`, ignoring
   errors;
3. removes its network record, its use markers under `<cache>/uses/`, its jail
   directory and its state directory.

It visits nothing else, so it leaves in place: network records under
`<state>/networks/` whose sandbox directory is gone (each keeps its `/30`
taken), jail directories without a sandbox directory, use markers of
sandboxes whose directory is gone (their disks are never evicted), and the
temporaries of interrupted image preparations (`<cache>/.acquire-*`,
`*.tmp`, `*.tmp.bundle`), which the cache limit does not count.

Two provider processes therefore cannot share the same state and cache
directories: the second to provision removes the sandboxes of the first.

## Data on disk

Everything the package stores lives under the two configured directories
([`runtime.ts`](src/lib/runtime.ts), [`network.ts`](src/lib/network.ts),
[`image.ts`](src/lib/image.ts)):

| Path                                       | Content                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `<state>/sandboxes/<id>/keys/`             | `management`, `user`, `host` key pairs and `known_hosts`                             |
| `<state>/sandboxes/<id>/state.json`        | `{ id, pid, tap, table, jailDirectory, baseMounted }`                                |
| `<state>/jailer/firecracker/<id>/root/`    | `vmlinux`, `initramfs.cpio`, `base.ext4` (bind mount), `writable.ext4`, `api.socket` |
| `<state>/networks/<id>`                    | The sandbox's `/30` index                                                            |
| `<state>/.network-lock`                    | Lock directory of the network allocation                                             |
| `<cache>/images/<key>.ext4`                | Immutable base disk (mode `0400`)                                                    |
| `<cache>/images/<key>.json`                | `{ digest, env, user }`                                                              |
| `<cache>/refs/<sha256 of reference>.json`  | `{ key }` of the last pull of that reference                                         |
| `<cache>/uses/<key>/<sandbox id>`          | Use marker; a disk with markers is never evicted                                     |
| `<cache>/locks/<key>`, `<cache>/.lru-lock` | Lock directories                                                                     |

Temporaries exist while an operation runs and are removed when it ends:

| Path                                          | Content                                               |
| --------------------------------------------- | ----------------------------------------------------- |
| `<cache>/.acquire-<random>/oci`               | OCI layout copied by `skopeo`                         |
| `<cache>/images/<key>.ext4.<uuid>.tmp`        | Base disk being built                                 |
| `<cache>/images/<key>.ext4.<uuid>.tmp.bundle` | Root filesystem unpacked by `umoci`                   |
| `<path>.<uuid>.tmp`                           | Reference or metadata record before its atomic rename |
| `<state>/sandboxes/<id>/seed-<uuid>/`         | Files copied into the writable disk's `/config`       |
| `<state>/sandboxes/<id>/writable.ext4`        | Writable disk before its move into the jail root      |

The directories the package creates have mode `0700`, except the lock
directories, created by a plain `mkdir` with the process's umask; the records it writes
(`state.json`, network records, reference and metadata files, use markers,
`known_hosts`) and the private keys have mode `0600`; the base disks and the
boot artifacts in the jail have mode `0400` ([`runtime.ts`](src/lib/runtime.ts),
[`network.ts`](src/lib/network.ts), [`image.ts`](src/lib/image.ts),
[`ssh.ts`](src/lib/ssh.ts)).

## Host commands

Every host command runs without a shell. All but `ssh` and the jailer run
through the internal runner ([`command.ts`](src/lib/command.ts)), whose errors
never carry the command's arguments or output:
`Firecracker host command could not start: <name>`,
`Firecracker host command failed: <name>` for a non-zero exit,
`Firecracker host command timed out: <name>`, and an `AbortError` when its
signal aborts, where `<name>` is the binary's base name.

`ssh` is spawned directly for each command ([`ssh.ts`](src/lib/ssh.ts),
[`process.ts`](src/lib/process.ts)). The jailer is spawned directly with its
output ignored and no `error` listener, so a jailer that cannot be spawned
raises an unhandled `error` event on its child process
([`command.ts`](src/lib/command.ts), [`runtime.ts`](src/lib/runtime.ts)).

## Host requirements

The preflight lists what the host must provide. The `firecracker` Compose
profile of the [host](../../app/backend/doric-host/README.md) packages it for
development and e2e: a privileged container on the host network with the pinned
assets at the default paths and the volumes `firecracker-state` and
`firecracker-cache` ([`compose.yaml`](../../app/backend/doric-host/compose.yaml),
[`.Dockerfile`](../../app/backend/doric-host/.Dockerfile)). It is a harness,
not a production isolation boundary.

## Build and test

| Target      | What it runs                                                                                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`     | `tsc` build to `dist/`, inferred by `@nx/js/typescript` ([`tsconfig.lib.json`](tsconfig.lib.json))                                                                                                                                                                |
| `typecheck` | Type check, inferred by `@nx/js/typescript`                                                                                                                                                                                                                       |
| `test`      | Compiles [`tsconfig.spec.json`](tsconfig.spec.json) and runs `node --test` on the compiled `dist-tests/tests/*.test.js`: API order and errors, client defaults and preflight order, network rules, the image cache and reference validation, and guest statistics |
| `e2e`       | Builds, compiles [`tsconfig.e2e.json`](tsconfig.e2e.json) and runs [`sandbox.e2e.ts`](tests/sandbox.e2e.ts), which needs a prepared host: it runs the preflight first and fails without one                                                                       |

```console
npx nx build firecracker-sandbox
npx nx typecheck firecracker-sandbox
npx nx test firecracker-sandbox
npx nx run firecracker-sandbox:e2e
```

The targets are defined in [`project.json`](project.json) and inferred from
[`nx.json`](../../nx.json).
