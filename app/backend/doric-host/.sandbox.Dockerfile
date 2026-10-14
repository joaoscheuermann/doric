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
#
# Docker's engine and CLI are installed there as well, so a sandbox can build
# the images its Project describes, the `docker build` in README.md included,
# and drive a daemon an operator exposes. The binaries alone give a sandbox no
# daemon: `dockerd` starts only where the container is granted the host's
# `/var/run/docker.sock` or the privileges it needs, so without one of those
# the CLI reports that it cannot reach a daemon rather than the command being
# missing.
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
# for bookworm. The client's own `js/lib/jquery.js` is a symlink into
# `libjs-jquery`, which `xpra` only *recommends*: under
# `--no-install-recommends` that link dangles and the screen panel embeds a
# client that never boots, so the library is listed and its asset checked
# below. `python3-pil` is the same gap on the server side and a fatal one: a
# client that says hello makes xpra import
# `xpra.server.source.client_connection`, that module imports
# `xpra.codecs.pillow.decoder`, and without Pillow every client — the panel's
# iframe included — is dropped with `error accepting new connection` right
# after its handshake, so the package is listed and its import checked below.
# `x11-apps` adds a known-good X client (`xclock`, `xeyes`) to prove a
# display serves. The checks fail the build on a missing soname, display,
# binary, client page, client asset or client-connection import rather than
# leaving a sandbox that cannot start a desktop app or serve the screen panel.
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
      libjs-jquery \
      libnspr4 \
      libnss3 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      python3-pil \
      x11-apps \
      xauth \
      xpra \
      xvfb \
 && rm -rf /var/lib/apt/lists/* \
 && ldconfig -p | grep -qE 'lib(nspr4|nss3|gtk-3|gbm|asound)\.so' \
 && xvfb-run -a true \
 && xpra --version \
 && test -f /usr/share/xpra/www/index.html \
 && test -f /usr/share/xpra/www/js/lib/jquery.js \
 && python3 -c 'from xpra.server.source.client_connection import ClientConnection'

# Debian's own `docker.io` is used rather than Docker's apt repository, which
# would add a third-party trust root this repository uses nowhere else; the
# documented image build is a plain `docker build`, which these binaries serve
# on both published architectures. The checks fail the build on a missing CLI
# or daemon rather than leaving a sandbox that cannot build an image. The
# Compose plugin stays out because the Compose commands in README.md drive the
# host deployment rather than anything a sandbox runs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      docker.io \
 && rm -rf /var/lib/apt/lists/* \
 && docker --version \
 && dockerd --version
