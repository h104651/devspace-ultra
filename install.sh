#!/usr/bin/env bash
set -euo pipefail

echo "DevSpace Ultra installer"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node.js >=22.19 and <27, then run this installer again." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required and should be installed with Node.js." >&2
  exit 1
fi

node_version="$(node --version | sed 's/^v//')"
node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || major >= 27 || (major === 22 && minor < 19)) {
  console.error(`Unsupported Node.js ${process.versions.node}. DevSpace Ultra requires >=22.19 and <27.`);
  process.exit(1);
}
'

echo "Node.js ${node_version} detected."
echo "Installing DevSpace Ultra from GitHub..."
npm install -g 'github:enwong93-sketch/devspace-ultra#main'

if ! command -v devspace-ultra >/dev/null 2>&1; then
  echo "Installation completed but devspace-ultra is not on PATH. Restart the shell and try again." >&2
  exit 1
fi

echo "DevSpace Ultra installed successfully."
case "$(uname -s 2>/dev/null || true)" in
  Darwin)
    echo "macOS: base DevSpace and Chat Swarm are supported. Autonomous Windows AppX ChatGPT Classic runtime cloning is not available on macOS."
    ;;
  Linux)
    echo "Linux: base DevSpace and Chat Swarm are supported. Autonomous Windows AppX ChatGPT Classic runtime cloning is not available on Linux."
    ;;
esac

echo
echo "Next:"
echo "  devspace-ultra init"
echo "  devspace-ultra serve"
echo
echo "The compatibility alias 'devspace' is also installed."
