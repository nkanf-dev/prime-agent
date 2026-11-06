# Prime Agent Team fork

This fork uses the `prime-agent-team` command and the `.prime-team/agent`
configuration directory. It is separate from the upstream `prime-agent` command
and `~/.prime/agent`. On first use, if the default Team configuration directory does not exist,
Team imports selected configuration from `~/.prime/agent`. It copies
`settings.json`, `models.json`, `auth.json`, `keybindings.json`, and
`mcp-connections.json` when present. The `sessionDir` setting is omitted to keep Team sessions separate. Credentials are sensitive: review local
access controls and back up the Team directory accordingly. Team never writes
back to the upstream directory. Existing Team directories are never migrated
or overwritten. An explicit `PRIME_AGENT_TEAM_CODING_AGENT_DIR` bypasses import.

## Paths and overrides

- User configuration, credentials, logs, catalog caches, and default sessions:
  `~/.prime-team/agent`.
- Repository sessions and artifacts: `.prime-team/agent` in the repository.
- Default daemon socket: `prime-agent-team-<uid>/daemon.sock` under the
  system temporary directory; Windows uses the `prime-agent-team-daemon` pipe.
- Supervisor ownership: `~/.prime-team/supervisor-owners`.
- Kernel virtual environment: `~/.prime-team/agent/kernel-venv`, with a
  separate `prime-team` XDG fallback if the default is not writable.
- The directory overrides derived from the command name are
  `PRIME_AGENT_TEAM_CODING_AGENT_DIR` and `PRIME_AGENT_TEAM_SESSION_DIR`.

Some lower-level overrides, including `PRIME_AGENT_KERNEL_VENV`,
`PRIME_AGENT_KERNEL_PYTHON` and the internal supervisor registry override,
retain upstream names. An inherited or explicitly supplied override can defeat
isolation. Unset these when independent state is required. An explicitly chosen
shared socket or shared directory also defeats isolation.

The Team package still loads its bundled skills. Imported settings keep their
configured skill and extension paths. Upstream implicit extensions and skills
under `~/.prime/agent` are not copied; add them explicitly if needed. The
common `~/.agents/skills` discovery path remains shared. Runtime data, sessions,
logs, caches, sockets, daemons and ledgers are never imported.

On Unix, newly created Team directories use mode 0700 and imported files use
0600. The import rejects symlinked source and target configuration paths and
invalid configuration JSON, and reports an error without printing file contents.
Repair the source or set `PRIME_AGENT_TEAM_CODING_AGENT_DIR` to a separate
configuration directory. If an interrupted import leaves
`~/.prime-team/.team-bootstrap-incomplete`, inspect the Team directory, repair or
remove the partial files, and remove the marker before retrying. If another Team
startup is importing, wait for it to finish instead of removing the marker. Do not remove upstream
files. Import is designed for Windows too, but has not been tested there; Windows
access controls are inherited from the parent directory, not Unix mode bits.

## Node distribution and installation (Linux and macOS)

Node.js 24 or later and npm are required. From a trusted Team release checkout
containing both `install-team.sh` and `install.sh`, run:

```sh
PRIME_AGENT_DOWNLOAD_BASE_URL=https://your-team-release-host ./install-team.sh stable
```

Replace the URL with the trusted release server. Publish the packer's complete
`artifacts` directory so that `stable` is at the base URL and the tarballs and
`SHA256SUMS` are under `releases/v<version>/`. For example, build using the
existing release packer with `--base-url` set to that same URL. The internal
package tarballs in the release reference that URL. The release version must
also be accepted by `install.sh` (use a version without `+` build metadata).
The checksum file is fetched from the same server; it is not a signature, so
trust in the HTTPS host and distribution of the installer is required.

The installer selects the Node path in `install.sh`, and uses the private npm
prefix `~/.local/share/prime-agent-team`, never the main global prefix. It links
`~/.local/bin/prime-agent-team` to that prefix. Add `~/.local/bin` to PATH if
needed. It refuses an unrecognised existing prefix or another executable with
that name on PATH or at the destination; inspect and move it manually. The
prefix is marked for later Team updates. It does not stop either daemon or
install over the upstream command. Configuration import happens on first Team use. It disables installer-time
runtime and search-tool downloads; these may be set up separately on first use.
The Team updater remains disabled: reinstall using a newer Team release.

The installer isolates npm configuration and uses the official npm registry
for public dependencies. Release-internal packages still come from the trusted
release server. This is not a fully offline bundle or a pinned transitive npm
lockfile. Keep the release artifacts and public dependency availability in mind.
Windows installation and command-link handling are not implemented. Do not use
the upstream native installer, Homebrew package, or updater for this fork.
