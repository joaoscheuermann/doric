# syntax=docker/dockerfile:1.11

# Pin the base image by digest so every stage uses the same reviewed Node and
# Debian userspace even if the upstream tag later moves.
ARG BASE_IMAGE=node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

# Build Doric and its built-in bundles in one stage so compilation is complete
# before the verified VMM and guest artifacts are assembled into the runtime.
FROM ${BASE_IMAGE} AS agent-builder
WORKDIR /workspace

# Root metadata and the relevant workspace trees are all required before
# installation: npm materializes workspace links and TypeScript follows project
# references across package boundaries while compiling Doric and its bundles.
COPY package.json package-lock.json nx.json tsconfig.json tsconfig.base.json ./
COPY agents ./agents
COPY bundles ./bundles
COPY packages ./packages
COPY tools ./tools

# Lifecycle scripts are initially disabled because dependencies are untrusted
# build inputs. Nx's required setup is then invoked explicitly. Direct tsc
# builds avoid coupling the container build to the Nx task graph, the Doric
# entrypoint is placed at the path expected by its package metadata, and the
# non-TypeScript bundle resources are staged beside the compiled bundle.
RUN npm ci --ignore-scripts \
 && node node_modules/nx/bin/post-install \
 && npx prisma generate --config agents/doric/prisma.config.ts \
 && npx tsc --build \
      agents/doric/tsconfig.lib.json \
      bundles/core/tsconfig.json \
      bundles/git/tsconfig.json \
      bundles/threads/tsconfig.json \
      --force \
 && mkdir -p agents/doric/dist/src \
 && mv agents/doric/dist/index.* agents/doric/dist/src/ \
 && mv agents/doric/dist/generated \
       agents/doric/dist/lib \
       agents/doric/dist/routes \
       agents/doric/dist/src/ \
 && cp bundles/core/manifest.json bundles/core/package.json agents/doric/dist/bundles/core/ \
 && cp -R bundles/core/skills agents/doric/dist/bundles/core/ \
 && cp bundles/git/manifest.json bundles/git/package.json agents/doric/dist/bundles/git/ \
 && cp -R bundles/git/skills agents/doric/dist/bundles/git/ \
 && cp bundles/threads/manifest.json bundles/threads/package.json agents/doric/dist/bundles/threads/ \
 && cp -R bundles/threads/skills agents/doric/dist/bundles/threads/

# Migration only needs the compiled workspace.
FROM ${BASE_IMAGE} AS agent-runtime
COPY --from=agent-builder /workspace /workspace
WORKDIR /workspace
ENV DORIC_HOST=0.0.0.0 \
    DORIC_PORT=3000
EXPOSE 3000
CMD ["node", "agents/doric/dist/src/index.js"]

# Compile static Dropbear first because both providers inject it into the
# selected OCI image for SSH access.
FROM ${BASE_IMAGE} AS dropbear-tools
ARG DROPBEAR_TAG=DROPBEAR_2026.94
ARG DROPBEAR_SHA256=827d3f6e510e7554ee18d5c6a00dfee1a6a555559495e65e2e8f8d41c79eed84
# The build uses a stable identity and timestamp.
ARG SOURCE_DATE_EPOCH=1767225600
ENV KBUILD_BUILD_HOST=doric \
    KBUILD_BUILD_TIMESTAMP=@${SOURCE_DATE_EPOCH} \
    KBUILD_BUILD_USER=doric \
    SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}
# This compiler toolchain is isolated to the builder stage. cpio and bzip2
# unpack sources, while zlib headers satisfy configure-time checks.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential ca-certificates curl cpio bzip2 zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build

# Dropbear provides both key generation and the key-only SSH server in one
# static multi-call binary. Login-accounting, zlib, and incompatible static
# link hardening features are disabled to keep it self-contained and avoid
# writes to host-style accounting files inside disposable guests.
RUN curl -fsSLo dropbear.tar.gz "https://codeload.github.com/mkj/dropbear/tar.gz/refs/tags/${DROPBEAR_TAG}" \
 && echo "${DROPBEAR_SHA256}  dropbear.tar.gz" | sha256sum -c - \
 && tar -xzf dropbear.tar.gz \
 && cd "dropbear-${DROPBEAR_TAG}" \
 && ./configure --disable-harden --disable-lastlog --disable-utmp --disable-utmpx --disable-wtmp --disable-wtmpx --disable-zlib \
 && make -j"$(nproc)" PROGRAMS="dropbear dropbearkey" MULTI=1 STATIC=1 \
 && install -m 0755 dropbearmulti /dropbearmulti

# The Docker runtime adds the host utilities and static Dropbear binary
# required by that provider.
FROM agent-runtime AS docker-runtime
ARG NFTABLES_VERSION=1.0.6-2+deb12u2
ARG OPENSSH_VERSION=1:9.2p1-2+deb12u10
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      "nftables=${NFTABLES_VERSION}" \
      "openssh-client=${OPENSSH_VERSION}" \
 && rm -rf /var/lib/apt/lists/*
COPY --from=dropbear-tools /dropbearmulti /opt/doric/firecracker/dropbearmulti
ENV DORIC_SANDBOX_SSH=true

# Firecracker additionally needs static BusyBox applets during early boot.
# Keep this stage after docker-runtime so legacy Docker builders targeting the
# Docker provider never compile Firecracker-only guest tooling.
FROM dropbear-tools AS guest-tools
ARG BUSYBOX_VERSION=1.37.0
ARG BUSYBOX_SHA256=3311dff32e746499f4df0d5df04d7eb396382d7e108bb9250e7b519b837043a4
RUN curl -fsSLo busybox.tar.bz2 "https://busybox.net/downloads/busybox-${BUSYBOX_VERSION}.tar.bz2" \
 && echo "${BUSYBOX_SHA256}  busybox.tar.bz2" | sha256sum -c - \
 && tar -xjf busybox.tar.bz2 \
 && cd "busybox-${BUSYBOX_VERSION}" \
 && make defconfig \
 && sed -i 's/^# CONFIG_STATIC is not set$/CONFIG_STATIC=y/' .config \
 && make -j"$(nproc)" busybox \
 && install -m 0755 busybox /busybox

# Fetch the Firecracker VMM and jailer directly from the pinned upstream
# release. The recorded checksum makes a changed or corrupted archive fail the
# build instead of silently entering the runtime image.
FROM ${BASE_IMAGE} AS firecracker-assets
ARG FIRECRACKER_VERSION=1.16.1
ARG FIRECRACKER_SHA256=382a02a869e4d6d5cb14c40577f9545e8458021ea8b0b2d3fc10ec14d9c242e6
# These packages exist only to authenticate, download, and unpack the release.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tar \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSLo /tmp/firecracker.tgz \
      "https://github.com/firecracker-microvm/firecracker/releases/download/v${FIRECRACKER_VERSION}/firecracker-v${FIRECRACKER_VERSION}-x86_64.tgz" \
 && echo "${FIRECRACKER_SHA256}  /tmp/firecracker.tgz" | sha256sum -c - \
 && tar -xzf /tmp/firecracker.tgz -C /tmp \
 && install -m 0755 "/tmp/release-v${FIRECRACKER_VERSION}-x86_64/firecracker-v${FIRECRACKER_VERSION}-x86_64" /firecracker \
 && install -m 0755 "/tmp/release-v${FIRECRACKER_VERSION}-x86_64/jailer-v${FIRECRACKER_VERSION}-x86_64" /jailer

# Build the exact guest kernel Doric boots. Building it here records the source
# checksum and required device support rather than relying on a mutable binary
# downloaded from an unrelated image host.
FROM ${BASE_IMAGE} AS kernel-builder
ARG LINUX_VERSION=6.18
ARG LINUX_SHA256=9106a4605da9e31ff17659d958782b815f9591ab308d03b0ee21aad6c7dced4b
# Fixed build identity and time remove machine- and clock-dependent metadata.
ARG SOURCE_DATE_EPOCH=1767225600
ENV KBUILD_BUILD_HOST=doric \
    KBUILD_BUILD_TIMESTAMP=@${SOURCE_DATE_EPOCH} \
    KBUILD_BUILD_USER=doric
# Kernel configuration and compilation require these tools and development
# headers; none are copied into the final runtime stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bc bison build-essential ca-certificates curl flex libelf-dev libssl-dev xz-utils \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl -fsSLo linux.tar.xz "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${LINUX_VERSION}.tar.xz" \
 && echo "${LINUX_SHA256}  linux.tar.xz" | sha256sum -c - \
 && tar -xJf linux.tar.xz
WORKDIR /build/linux-6.18

# The kernel is deliberately monolithic: initramfs boot, devtmpfs, ext4, and
# OverlayFS provide the immutable-base/writable-layer filesystem; VirtIO
# supplies disks, networking, and entropy; the serial console exposes boot
# diagnostics. Module loading and generated trust stores are disabled because
# guests cannot add kernel features at runtime and reproducibility matters.
RUN make x86_64_defconfig \
 && scripts/config \
      --enable BLK_DEV_INITRD \
      --enable DEVTMPFS \
      --enable DEVTMPFS_MOUNT \
      --enable EXT4_FS \
      --enable HW_RANDOM \
      --enable HW_RANDOM_VIRTIO \
      --enable OVERLAY_FS \
      --enable SERIAL_8250 \
      --enable SERIAL_8250_CONSOLE \
      --enable TUN \
      --enable VIRTIO \
      --enable VIRTIO_BLK \
      --enable VIRTIO_MMIO \
      --enable VIRTIO_NET \
      --disable MODULE_SIG \
      --disable MODULES \
      --disable SYSTEM_REVOCATION_LIST \
      --disable SYSTEM_TRUSTED_KEYRING \
      --set-str SYSTEM_REVOCATION_KEYS "" \
      --set-str SYSTEM_TRUSTED_KEYS "" \
 && make olddefconfig \
 && make -j"$(nproc)" vmlinux

# Assemble the minimal initial filesystem that runs before the OCI image. It
# mounts the immutable base and writable ext4 disk as OverlayFS, configures the
# management network, and hands control to Doric's guest bootstrap service.
FROM ${BASE_IMAGE} AS initramfs-builder
ARG SOURCE_DATE_EPOCH=1767225600
# cpio emits the archive format consumed directly by the Linux kernel.
RUN apt-get update \
 && apt-get install -y --no-install-recommends cpio \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /initramfs
# Create only the mount points and executable locations needed during boot.
RUN mkdir -p bin dev etc newroot proc run state sys usr/sbin
# Static helpers remain usable even when the source OCI image is very small.
COPY --from=guest-tools /busybox bin/busybox
COPY --from=guest-tools /dropbearmulti usr/sbin/dropbearmulti
# These scripts own early boot and the post-pivot Doric guest services.
COPY agents/doric/firecracker/init init
COPY agents/doric/firecracker/guest-start usr/sbin/doric-guest-start

# BusyBox applet links provide the exact commands used by the boot scripts.
# Stable timestamps, sorted paths, and root ownership make the cpio archive
# deterministic across clean builds.
RUN chmod 0755 init usr/sbin/doric-guest-start \
 && for applet in sh mount mkdir mknod sleep switch_root cp ln cat ip chmod chown; do ln -s busybox "bin/${applet}"; done \
 && find . -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} + \
 && find . -print0 | sort -z | cpio --null --create --format=newc --owner=0:0 --reproducible --quiet > /initramfs.cpio

# The final image is the common Doric host for both sandbox providers. Compose
# grants the Docker socket only to the Docker profile and KVM/TUN only to the
# Firecracker profile; this image itself does not assume either is present.
FROM ${BASE_IMAGE} AS runtime
# Debian package versions and the standalone umoci binary are pinned so image
# rebuilds cannot silently change host-side image or network behavior.
ARG SKOPEO_VERSION=1.9.3+ds1-1+b10
ARG E2FSPROGS_VERSION=1.47.0-2+b2
ARG NFTABLES_VERSION=1.0.6-2+deb12u2
ARG IPROUTE2_VERSION=6.1.0-3
ARG OPENSSH_VERSION=1:9.2p1-2+deb12u10
ARG SOCAT_VERSION=1.7.4.4-2
ARG UMOCI_VERSION=0.6.0
ARG UMOCI_SHA256=b51c267ec394499e42c6fde47f240b7b7dba57ea49df0b5acd304378b82a3b71

# Runtime responsibilities by package:
# - e2fsprogs builds immutable base and per-VM writable ext4 filesystems;
# - iproute2 creates TAP devices, addresses, and routes;
# - nftables enforces isolation, protected destinations, forwarding, and NAT;
# - openssh-client drives private management SSH and strict user SSH checks;
# - skopeo resolves and downloads public OCI manifests without Docker Engine;
# - socat exposes optional user SSH through a host-side TCP proxy;
# - CA certificates and curl securely fetch the separately pinned umoci tool.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl \
      "e2fsprogs=${E2FSPROGS_VERSION}" \
      "iproute2=${IPROUTE2_VERSION}" \
      "nftables=${NFTABLES_VERSION}" \
      "openssh-client=${OPENSSH_VERSION}" \
      "skopeo=${SKOPEO_VERSION}" \
      "socat=${SOCAT_VERSION}" \
 && rm -rf /var/lib/apt/lists/*

# umoci securely unpacks the selected linux/amd64 OCI manifest and applies its
# layers before Doric converts the result to an immutable ext4 base disk.
RUN curl -fsSLo /usr/local/bin/umoci \
      "https://github.com/opencontainers/umoci/releases/download/v${UMOCI_VERSION}/umoci.linux.amd64" \
 && echo "${UMOCI_SHA256}  /usr/local/bin/umoci" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/umoci

# Only the verified outputs of the builder stages enter the runtime image.
COPY --from=firecracker-assets /firecracker /usr/local/bin/firecracker
COPY --from=firecracker-assets /jailer /usr/local/bin/jailer
COPY --from=kernel-builder /build/linux-6.18/vmlinux /opt/doric/firecracker/vmlinux
COPY --from=initramfs-builder /initramfs.cpio /opt/doric/firecracker/initramfs.cpio
# Keep source-image-independent helpers available to both provider runtimes.
COPY --from=guest-tools /busybox /opt/doric/firecracker/busybox
COPY --from=guest-tools /dropbearmulti /opt/doric/firecracker/dropbearmulti
# Copy the prepared workspace as a unit so npm workspace links, compiled package
# outputs, runtime dependencies, and non-code bundle resources stay aligned.
COPY --from=agent-builder /workspace /workspace
WORKDIR /workspace

# Express and Socket.IO share Doric's HTTP listener. Binding to all container
# interfaces makes the service reachable through Docker networking, while the
# port remains overridable when Doric runs outside this image.
ENV DORIC_HOST=0.0.0.0 \
    DORIC_PORT=3000 \
    DORIC_SANDBOX_SSH=true
EXPOSE 3000

# VM state and the persistent converted-rootfs cache contain keys and mutable
# sandbox artifacts, so default them to owner-only permissions. Compose mounts
# durable volumes over these paths for the Firecracker profile.
RUN mkdir -p /var/lib/doric/firecracker /var/cache/doric/firecracker \
 && chmod 0700 /var/lib/doric/firecracker /var/cache/doric/firecracker

# Doric selects Docker by default or Firecracker through
# DORIC_SANDBOX_PROVIDER; provider setup remains inside the composition root.
CMD ["node", "agents/doric/dist/src/index.js"]
