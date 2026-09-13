set -eu
agent_node=/opt/benchflow/node
agent_node_version=22.20.0
if ! command -v curl >/dev/null 2>&1 || ! command -v xz >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates xz-utils
fi
if [ ! -x "$agent_node/bin/node" ]; then
  case "$(uname -m)" in
    x86_64|amd64) agent_arch=x64; agent_sha=00bbd05e306ea68b6e13e17360d0e2f680b493ef95f2fea1c4296ff7437530bc ;;
    aarch64|arm64) agent_arch=arm64; agent_sha=06907b9c088ce62305bc1530e5c1ae1510245114645768f7750c349c5b6fe667 ;;
    *) echo 'Unsupported Node architecture' >&2; exit 1 ;;
  esac
  agent_tmp=$(mktemp -d)
  curl -fsSLo "$agent_tmp/node.tar.xz" "https://nodejs.org/dist/v$agent_node_version/node-v$agent_node_version-linux-$agent_arch.tar.xz"
  printf '%s  %s\n' "$agent_sha" "$agent_tmp/node.tar.xz" | sha256sum -c -
  mkdir -p "$agent_node"
  tar -xJf "$agent_tmp/node.tar.xz" -C "$agent_node" --strip-components=1 --no-same-owner
  rm "$agent_tmp/node.tar.xz"
  rmdir "$agent_tmp"
fi
