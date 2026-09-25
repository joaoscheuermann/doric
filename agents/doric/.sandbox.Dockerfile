# syntax=docker/dockerfile:1.11

# The image Doric runs agent sandboxes from. It is a deployment choice rather
# than a baked-in value: the host reads DORIC_SANDBOX_IMAGE and defaults to the
# plain `node:22-bookworm` image named here, so this image takes effect only
# where an operator builds it and points that variable (or a published tag) at
# it. A locally built tag that is absent makes the provider's image pull fail
# instead of silently falling back to the plain image.
#
# Git ships with the base image and is verified below rather than assumed. The
# GitHub CLI is downloaded from its pinned release and checksum-checked the way
# the host `.Dockerfile` pins its own downloads, so a changed archive fails the
# build instead of entering the sandbox.
FROM node:22-bookworm

ARG GH_VERSION=2.101.0
# Checksums published as gh_<version>_checksums.txt beside each release asset.
ARG GH_SHA256_AMD64=9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8
ARG GH_SHA256_ARM64=b57e8063f18862647c9d22727c32e9da1b963f8bf9db648fe123a6975695640f
ARG TARGETARCH

# `-f` fails on HTTP errors, `sha256sum -c` fails on a mismatch, and the version
# checks fail the build if either command is missing, rather than leaving a
# sandbox without the tools the GitHub block authenticates.
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "${arch}" in \
      amd64) sha256="${GH_SHA256_AMD64}" ;; \
      arm64) sha256="${GH_SHA256_ARM64}" ;; \
      *) echo "unsupported sandbox architecture: ${arch}" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/gh.tar.gz \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz"; \
    echo "${sha256}  /tmp/gh.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/gh.tar.gz -C /tmp; \
    install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_${arch}"; \
    git --version; \
    gh --version
