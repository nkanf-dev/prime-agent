#!/bin/sh
# Install a Team release without touching the upstream npm prefix.
set -eu

case "$(uname -s)" in Linux|Darwin) ;; *) echo 'error: Team installation currently supports Linux and macOS only.' >&2; exit 1 ;; esac
: "${HOME:?HOME must be set}"
[ "$#" -le 1 ] || { echo 'usage: PRIME_AGENT_TEAM_GITHUB_REPO=owner/repo ./install-team.sh version' >&2; exit 1; }
release_layout=${PRIME_AGENT_TEAM_RELEASE_LAYOUT:-standard}
release_base=${PRIME_AGENT_DOWNLOAD_BASE_URL:-}
if [ -n "${PRIME_AGENT_TEAM_GITHUB_REPO:-}" ]; then
    [ -z "$release_base" ] && [ "$release_layout" = standard ] || { echo 'error: choose a GitHub repository or a release base, not both.' >&2; exit 1; }
    repo=$PRIME_AGENT_TEAM_GITHUB_REPO
    case "$repo" in */*) owner=${repo%%/*}; name=${repo#*/} ;; *) owner=; name= ;; esac
    case "$owner" in ''|*[!A-Za-z0-9-]*) echo 'error: invalid GitHub owner/repository.' >&2; exit 1 ;; esac
    case "$name" in ''|.*|*..*|*[!A-Za-z0-9_.-]*) echo 'error: invalid GitHub owner/repository.' >&2; exit 1 ;; esac
    release_base="https://github.com/$owner/$name"
    release_layout=github
fi
case "$release_layout" in
    standard) ;;
    github) [ "$#" -eq 1 ] && [ "$1" != stable ] && [ "$1" != beta ] || { echo 'error: GitHub Team releases require a fixed version.' >&2; exit 1; } ;;
    *) echo 'error: invalid Team release layout.' >&2; exit 1 ;;
esac
[ -n "$release_base" ] || { echo 'error: set PRIME_AGENT_TEAM_GITHUB_REPO or PRIME_AGENT_DOWNLOAD_BASE_URL.' >&2; exit 1; }
node_command=${PRIME_AGENT_TEAM_NODE:-$(command -v node 2>/dev/null || :)}
[ -n "$node_command" ] || { echo 'error: Node.js 24 or later is required. Add it to PATH or set PRIME_AGENT_TEAM_NODE to its executable.' >&2; exit 1; }
node_dir=$(CDPATH= cd -- "$(dirname -- "$node_command")" && pwd -P) || { echo 'error: cannot locate the Node.js directory.' >&2; exit 1; }
node_path="$node_dir/$(basename -- "$node_command")"
case "$node_path" in *'
'*) echo 'error: Node.js path must not contain a newline.' >&2; exit 1 ;; esac
PATH="$node_dir${PATH:+:$PATH}"
export PATH
[ -x "$node_path" ] && command -v npm >/dev/null 2>&1 && "$node_path" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || {
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
team_wrapper() {
    cat <<'TEAM_WRAPPER'
#!/bin/sh
# prime-agent-team-managed-wrapper-v1
set -eu
wrapper=$0
if [ -L "$wrapper" ]; then
    link_target=$(readlink "$wrapper")
    case "$link_target" in
        /*) wrapper=$link_target ;;
        *) wrapper=$(dirname -- "$wrapper")/$link_target ;;
    esac
fi
wrapper_dir=$(CDPATH= cd -- "$(dirname -- "$wrapper")" && pwd -P)
if ! IFS= read -r node_path < "$wrapper_dir/../node-path" || [ ! -x "$node_path" ]; then
    echo 'error: the configured Team Node.js is unavailable. Reinstall with PRIME_AGENT_TEAM_NODE set to Node.js 24 or later.' >&2
    exit 1
fi
PATH="$(dirname -- "$node_path")${PATH:+:$PATH}"
export PATH
exec "$node_path" "$wrapper_dir/../lib/node_modules/prime-agent-team/dist/bundle/cli.js" "$@"
TEAM_WRAPPER
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
managed_wrapper=0
if [ -e "$target" ] || [ -L "$target" ]; then
    if [ -L "$target" ] && [ "$(readlink "$target")" = '../lib/node_modules/prime-agent-team/dist/bundle/cli.js' ]; then
        :
    elif [ -f "$target" ] && [ ! -L "$target" ] && team_wrapper | cmp -s "$target" -; then
        managed_wrapper=1
    else
        conflict "$target"
    fi
fi
node_file="$prefix/node-path"
if [ -e "$node_file" ] || [ -L "$node_file" ]; then
    [ "$managed_wrapper" = 1 ] && [ -f "$node_file" ] && [ ! -L "$node_file" ] || conflict "$node_file"
fi
for team_path in "$prefix/lib" "$prefix/bin" "$prefix/npm-cache" "$prefix/lib/node_modules" \
    "$prefix/lib/node_modules/.bin" "$prefix/lib/node_modules/.package-lock.json" \
    "$prefix/lib/node_modules/prime-agent-team" "$prefix/lib/node_modules/@earendil-works" \
    "$prefix/lib/node_modules/@earendil-works/pi-ai" "$prefix/lib/node_modules/@earendil-works/pi-agent-core" \
    "$prefix/lib/node_modules/@earendil-works/pi-tui" "$prefix/lib/package-lock.json"; do
    [ ! -L "$team_path" ] || { printf 'error: refusing symlink %s; inspect it manually.\n' "$team_path" >&2; exit 1; }
done
for team_npmrc in "$prefix/lib/.npmrc" "$prefix/.global-npmrc"; do
    if [ -e "$team_npmrc" ] || [ -L "$team_npmrc" ]; then
        printf 'error: refusing unmanaged npm configuration %s; inspect it manually.\n' "$team_npmrc" >&2; exit 1
    fi
done
mkdir -p "$HOME/.local/bin"
# Start with a clean npm environment to prevent inherited prefix/registry overrides.
# Disable optional tool/runtime downloads; the Team CLI can bootstrap on first use.
env -i HOME="$HOME" PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
    PRIME_AGENT_DOWNLOAD_BASE_URL="$release_base" PRIME_AGENT_RELEASE_LAYOUT="$release_layout" \
    PRIME_AGENT_ALLOW_INSECURE_HTTP_FOR_TESTS="${PRIME_AGENT_ALLOW_INSECURE_HTTP_FOR_TESTS:-0}" \
    PRIME_AGENT_PACKAGE=prime-agent-team PRIME_AGENT_CMD=prime-agent-team PRIME_AGENT_TEAM_VERIFIED_INSTALL=1 \
    PRIME_AGENT_INSTALL_METHOD=node PRIME_AGENT_INSTALLER_PLAIN=1 \
    PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=0 PI_OFFLINE=1 \
    npm_config_prefix="$prefix" npm_config_cache="$prefix/npm-cache" \
    npm_config_registry=https://registry.npmjs.org/ npm_config_userconfig=/dev/null npm_config_globalconfig="$prefix/.global-npmrc" \
    sh "$installer_dir/install.sh" "$@"
[ -x "$prefix/lib/node_modules/prime-agent-team/dist/bundle/cli.js" ] || { echo 'error: Team command was not installed; check the installer output.' >&2; exit 1; }
wrapper_temp=$(mktemp "$prefix/bin/.team-wrapper.XXXXXX")
node_temp=$(mktemp "$prefix/.team-node.XXXXXX") || { rm -f "$wrapper_temp"; exit 1; }
trap 'rm -f "$wrapper_temp" "$node_temp"' EXIT
team_wrapper > "$wrapper_temp"
chmod 700 "$wrapper_temp"
printf '%s\n' "$node_path" > "$node_temp"
chmod 600 "$node_temp"
mv -f "$node_temp" "$node_file"
mv -f "$wrapper_temp" "$target"
if [ ! -L "$link" ]; then
    ln -s "$target" "$link" || { echo 'error: could not create command link; inspect the destination manually.' >&2; exit 1; }
fi
printf '\nTeam command: %s\n' "$link"
