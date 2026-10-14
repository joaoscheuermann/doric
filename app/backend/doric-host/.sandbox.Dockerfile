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
#
# Electron's runtime libraries and Xvfb installed at the end let a sandbox
# build and run Electron desktop apps, the Doric desktop app among them, with
# no display of its own. Xpra is installed there too: it serves a display plus
# its own HTML5 client, which the desktop's screen panel embeds, so the panel
# can watch and drive the GUI apps a sandbox builds.
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

# Electron embeds Chromium, which links these system libraries at runtime;
# `xvfb-run` needs `xauth` under `--no-install-recommends` and gives a
# container with no display a headless X server. A root container starts
# Electron with `--no-sandbox`, as Chromium's setuid helper cannot be used
# there. `xpra` brings its own Xvfb-style display, X server utilities and the
# HTML5 client under `/usr/share/xpra/www`, and both architectures publish it
# for bookworm. The checks fail the build on a missing soname, display, binary
# or client page rather than leaving a sandbox that cannot start a desktop app
# or serve the screen panel.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libasound2 \
      libatk1.0-0 \
      libatk-bridge2.0-0 \
      libatspi2.0-0 \
      libcups2 \
      libdbus-1-3 \
      libgbm1 \
      libgtk-3-0 \
      libnspr4 \
      libnss3 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      xauth \
      xpra \
      xvfb \
 && rm -rf /var/lib/apt/lists/* \
 && ldconfig -p | grep -qE 'lib(nspr4|nss3|gtk-3|gbm|asound)\.so' \
 && xvfb-run -a true \
 && xpra --version \
 && test -f /usr/share/xpra/www/index.html
