#!/bin/sh
# Install a Team release without touching the upstream npm prefix.
set -eu

case "$(uname -s)" in Linux|Darwin) ;; *) echo 'error: Team installation currently supports Linux and macOS only.' >&2; exit 1 ;; esac
: "${HOME:?HOME must be set}"
[ "$#" -le 1 ] || { echo 'usage: PRIME_AGENT_DOWNLOAD_BASE_URL=https://... ./install-team.sh [version|stable|beta]' >&2; exit 1; }
: "${PRIME_AGENT_DOWNLOAD_BASE_URL:?Set PRIME_AGENT_DOWNLOAD_BASE_URL to the trusted Team release server}"
command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || {
    echo 'error: Node.js 24 or later and npm are required. Install them manually first.' >&2; exit 1;
}
prefix="$HOME/.local/share/prime-agent-team"
link="$HOME/.local/bin/prime-agent-team"
target="$prefix/bin/prime-agent-team"
marker="$prefix/.prime-agent-team-prefix-v1"
installer_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
[ -f "$installer_dir/install.sh" ] || { echo 'error: install.sh must be next to install-team.sh.' >&2; exit 1; }

conflict() {
    printf 'error: conflicting prime-agent-team at %s. Inspect and manually move or remove it, then retry. Nothing was overwritten.\n' "$1" >&2
    exit 1
}
# Check the destination even if it is not in PATH, including dangling symlinks.
if [ -e "$link" ] || [ -L "$link" ]; then
    [ -L "$link" ] && [ "$(readlink "$link")" = "$target" ] || conflict "$link"
fi
remaining_path=${PATH:-}
while :; do
    case "$remaining_path" in
        *:*) dir=${remaining_path%%:*}; remaining_path=${remaining_path#*:}; more=1 ;;
        *) dir=$remaining_path; more=0 ;;
    esac
    [ -n "$dir" ] || dir=.
    candidate="$dir/prime-agent-team"
    if [ -f "$candidate" ] && [ -x "$candidate" ]; then
        case "$candidate" in "$link"|"$target") ;; *) conflict "$candidate" ;; esac
    fi
    [ "$more" = 1 ] || break
done
if [ -e "$prefix" ] || [ -L "$prefix" ]; then
    [ -d "$prefix" ] && [ ! -L "$prefix" ] && [ -f "$marker" ] && [ ! -L "$marker" ] && [ "$(cat "$marker")" = 'prime-agent-team npm prefix v1' ] || {
        printf 'error: %s is not a Team-managed prefix. Inspect and manually move it before retrying.\n' "$prefix" >&2; exit 1;
    }
else
    mkdir -p "$prefix"
    printf '%s\n' 'prime-agent-team npm prefix v1' > "$marker"
fi
if [ -e "$target" ] || [ -L "$target" ]; then
    [ -L "$target" ] && [ "$(readlink "$target")" = '../lib/node_modules/prime-agent-team/dist/bundle/cli.js' ] || conflict "$target"
fi
mkdir -p "$HOME/.local/bin"
# Start with a clean npm environment to prevent inherited prefix/registry overrides.
# Disable optional tool/runtime downloads; the Team CLI can bootstrap on first use.
env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
    PRIME_AGENT_DOWNLOAD_BASE_URL="$PRIME_AGENT_DOWNLOAD_BASE_URL" \
    PRIME_AGENT_ALLOW_INSECURE_HTTP_FOR_TESTS="${PRIME_AGENT_ALLOW_INSECURE_HTTP_FOR_TESTS:-0}" \
    PRIME_AGENT_PACKAGE=prime-agent-team PRIME_AGENT_CMD=prime-agent-team \
    PRIME_AGENT_INSTALL_METHOD=node PRIME_AGENT_INSTALLER_PLAIN=1 \
    PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=0 PI_OFFLINE=1 \
    npm_config_prefix="$prefix" npm_config_cache="$prefix/npm-cache" \
    npm_config_registry=https://registry.npmjs.org/ npm_config_userconfig=/dev/null npm_config_globalconfig="$prefix/.global-npmrc" \
    sh "$installer_dir/install.sh" "$@"
[ -x "$target" ] || { echo 'error: Team command was not installed; check the installer output.' >&2; exit 1; }
if [ ! -L "$link" ]; then
    ln -s "$target" "$link" || { echo 'error: could not create command link; inspect the destination manually.' >&2; exit 1; }
fi
printf '\nTeam command: %s\n' "$link"
