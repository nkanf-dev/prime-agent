import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const installerSource = readFileSync("install.sh", "utf-8");
const mainCall = '\nmain "$@"';
const mainCallIndex = installerSource.lastIndexOf(mainCall);
const ansiPattern = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const syncEnd = "\x1b[?2026l";
const failures = [];

if (mainCallIndex === -1) {
	console.error('Installer check failed: could not find final main "$@" call.');
	process.exit(1);
}

const harnessSource = `${installerSource.slice(0, mainCallIndex)}

prime_agent_test_cols=80
prime_agent_test_rows=24

prime_agent_read_terminal_size() {
	prime_agent_screen_cols="$prime_agent_test_cols"
	prime_agent_screen_rows="$prime_agent_test_rows"
}

print_render_meta() {
	label="$1"
	if prime_agent_show_logo; then
		visible=1
	else
		visible=0
	fi
	content_height=$(prime_agent_content_height)
	printf '__META__ %s cols=%s rows=%s layout_show_logo=%s lab_width=%s render_lab_width=%s compact=%s visible=%s content_height=%s\\n' \\
		"$label" "$prime_agent_screen_cols" "$prime_agent_screen_rows" "$prime_agent_screen_layout_show_logo" \\
		"$prime_agent_screen_layout_lab_width" "$prime_agent_screen_render_lab_width" "$prime_agent_screen_compact" "$visible" "$content_height"
}

render_case() {
	prime_agent_screen_title="Installing Prime Agent"
	prime_agent_screen_detail="Fetching the verified package."
	prime_agent_screen_question=
	prime_agent_screen_frame=1
	prime_agent_screen_cols="$1"
	prime_agent_screen_rows="$2"
	prime_agent_screen_layout_ready=0
	prime_agent_screen_layout_show_logo=0
	prime_agent_screen_layout_lab_width=0
	prime_agent_screen_render_lab_width=0
	prime_agent_screen_compact=0
	prime_agent_init_screen_layout
	prime_agent_refresh_screen_layout_mode
	print_render_meta first
	printf '__RENDER_START__ first\\n'
	prime_agent_render_screen
	printf '__RENDER_END__ first\\n'

	prime_agent_screen_frame=2
	prime_agent_screen_cols="$3"
	prime_agent_screen_rows="$4"
	prime_agent_refresh_screen_layout_mode
	print_render_meta second
	printf '__RENDER_START__ second\\n'
	prime_agent_render_screen
	printf '__RENDER_END__ second\\n'
}

screen_case() {
	prime_agent_screen_enabled=1
	prime_agent_screen_drawn=0
	prime_agent_screen_last_cols=0
	prime_agent_screen_last_rows=0
	prime_agent_screen_layout_ready=0
	prime_agent_screen_layout_show_logo=0
	prime_agent_screen_layout_lab_width=0
	prime_agent_screen_render_lab_width=0
	prime_agent_screen_compact=0
	prime_agent_screen_frame=0

	prime_agent_test_cols="$1"
	prime_agent_test_rows="$2"
	printf '__SCREEN_START__ first\\n' >&2
	prime_agent_screen "Installing Prime Agent" "Installing Prime Agent" "Fetching the verified package." ""
	printf '__SCREEN_END__ first\\n' >&2

	prime_agent_test_cols="$3"
	prime_agent_test_rows="$4"
	printf '__SCREEN_START__ second\\n' >&2
	prime_agent_screen "Installing Prime Agent" "Installing Prime Agent" "Fetching the verified package." ""
	printf '__SCREEN_END__ second\\n' >&2
}

progress_case() {
	progress_details="Preparing global install.
Linking command binaries.
Finalizing npm install."
	for progress_frame in 1 24 25 48 49 200; do
		prime_agent_animation_frame="$progress_frame"
		printf '__PROGRESS__ %s\t%s\t%s\\n' "$progress_frame" "$(prime_agent_animation_status "Installing Prime Agent" "$progress_details" static)" "$(prime_agent_animation_detail "$progress_details")"
	done
}

render_case "$@"
screen_case "$@"
progress_case
`;

const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-installer-render-"));
const harnessPath = join(tempDir, "harness.sh");

try {
	writeFileSync(harnessPath, harnessSource, "utf-8");

	const stableVisible = runCase("stable visible logo", 100, 30, 90, 30);
	check(stableVisible.meta.first.visible === "1", "expected the initial large render to show the logo");
	check(stableVisible.meta.second.visible === "1", "expected a safe resize to keep showing the logo");
	check(
		stableVisible.meta.first.lab_width === stableVisible.meta.second.lab_width,
		"expected logo lab width to stay stable across a safe resize",
	);
	assertInstallerProgress(stableVisible.progress);

	const stableExpand = runCase("stable expanded logo", 60, 24, 120, 32);
	check(stableExpand.meta.first.visible === "1", "expected the initial medium render to show the logo");
	check(stableExpand.meta.second.visible === "1", "expected terminal growth to keep showing the logo");
	check(
		stableExpand.meta.first.lab_width === stableExpand.meta.second.lab_width,
		"expected logo lab width not to grow after terminal expansion",
	);

	const noLogoStart = runCase("small initial terminal", 41, 24, 100, 30);
	check(noLogoStart.meta.first.layout_show_logo === "0", "expected a too-narrow initial terminal to freeze text-only layout");
	check(noLogoStart.meta.second.visible === "0", "expected terminal growth not to enable a logo after text-only layout was frozen");

	const narrowLogo = runCase("narrow logo on width shrink", 100, 30, 60, 24);
	check(narrowLogo.meta.first.visible === "1", "expected the initial wide render to show the logo");
	check(narrowLogo.meta.second.compact === "0", "expected shrink below frozen lab width to keep rendering the logo");
	check(narrowLogo.meta.second.visible === "1", "expected narrow width mode to keep showing the logo");
	check(
		Number(narrowLogo.meta.second.render_lab_width) <= 59,
		"expected narrow width mode to keep the rendered lab width inside the resized terminal",
	);

	const compactWidth = runCase("compact on severe width shrink", 100, 30, 32, 24);
	check(compactWidth.meta.first.visible === "1", "expected the initial wide render to show the logo");
	check(compactWidth.meta.second.compact === "1", "expected shrink below logo width to use compact mode");
	check(compactWidth.meta.second.visible === "0", "expected severe compact width mode to hide the logo");

	const compactRows = runCase("compact on row shrink", 100, 30, 100, 10);
	check(compactRows.meta.first.visible === "1", "expected the initial tall render to show the logo");
	check(compactRows.meta.second.compact === "1", "expected shrink below frozen splash height to use compact mode");
	check(compactRows.meta.second.visible === "0", "expected compact row mode to hide the logo");

	checkNpmInstallPolicies();
	checkVersionResolution();
	checkGithubReleaseLayout();
	checkVerifiedTeamPackages();
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(["Installer check failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
	process.exit(1);
}

console.log("Installer check passed.");

function checkVersionResolution() {
	const versionHarnessPath = join(tempDir, "version-harness.sh");
	writeFileSync(versionHarnessPath, `${installerSource.slice(0, mainCallIndex)}
prime_agent_curl_download() { printf '%s' "$TEST_CHANNEL_VERSION" > "$4"; }
prime_agent_run_quiet_with_animation() { shift 3; "$@"; }
resolve_prime_agent_version "$@"
`, "utf-8");
	const valid = [
		["0.9.8+fork.4", "0.9.8+fork.4"],
		["v0.9.8+fork.4", "0.9.8+fork.4"],
		["0.9.8-team.1", "0.9.8-team.1"],
		["stable", "0.9.8+fork.4"],
		["beta", "0.9.8+fork.4"],
	];
	for (const [input, expected] of valid) {
		const result = spawnSync("sh", [versionHarnessPath, input], {
			encoding: "utf-8",
			env: { ...process.env, PRIME_AGENT_VERSION: "", TEST_CHANNEL_VERSION: "v0.9.8+fork.4" },
		});
		check(result.status === 0 && result.stdout === expected, `version ${input} should resolve to ${expected}: ${result.stderr}`);
	}
	for (const input of [".", "..", "../x", "1.0.0/../../x", "1.0.0%2f..", "1.0.0?x", "1.0.0#x", "1.0.0+", "+build", "1.0.0++x", "1.0.0+.x", "1.0.0+x..y", "1.0.0+x."]) {
		const result = spawnSync("sh", [versionHarnessPath, input], { encoding: "utf-8" });
		check(result.status !== 0 && result.stderr.includes("invalid Prime Agent version"), `unsafe version ${input} must be rejected`);
	}
	for (const channel of ["stable", "beta"]) {
		const result = spawnSync("sh", [versionHarnessPath, channel], {
			encoding: "utf-8",
			env: { ...process.env, PRIME_AGENT_VERSION: "", TEST_CHANNEL_VERSION: "0.9.8+fork/../../bad" },
		});
		check(result.status !== 0 && result.stderr.includes("invalid Prime Agent version"), `${channel}: unsafe channel version must be rejected`);
	}
}

function checkGithubReleaseLayout() {
	const urlHarnessPath = join(tempDir, "url-harness.sh");
	writeFileSync(urlHarnessPath, `${installerSource.slice(0, mainCallIndex)}
prime_agent_release_url "$1" "$2"
`, "utf-8");
	const version = "0.9.8+fork.4";
	const name = `prime-agent-team-${version}.tgz`;
	for (const [layout, expected] of [
		["standard", `https://example.test/repo/releases/v${version}/${name}`],
		["github", "https://example.test/repo/releases/download/team-v0.9.8%2Bfork.4/prime-agent-team-0.9.8%2Bfork.4.tgz"],
	]) {
		const result = spawnSync("sh", [urlHarnessPath, version, name], {
			encoding: "utf-8", env: { ...process.env, PRIME_AGENT_DOWNLOAD_BASE_URL: "https://example.test/repo", PRIME_AGENT_RELEASE_LAYOUT: layout },
		});
		check(result.status === 0 && result.stdout === expected, `${layout}: incorrect release URL: ${result.stdout}${result.stderr}`);
	}
	for (const versionArg of ["stable", "beta", "0.9.8+../bad", "0.9.8++x", "01.2.3+build", "1.2.3-01+build"]) {
		const result = spawnSync("sh", ["install.sh", versionArg], {
			encoding: "utf-8", env: { ...process.env, PRIME_AGENT_DOWNLOAD_BASE_URL: "https://example.test/repo", PRIME_AGENT_RELEASE_LAYOUT: "github", PRIME_AGENT_INSTALL_METHOD: "node" },
		});
		check(result.status !== 0 && result.stderr.includes("version"), `github: unsafe or non-fixed version ${versionArg} must fail`);
	}
	const teamDir = join(tempDir, "team-entry");
	const teamHome = join(tempDir, "team-home");
	mkdirSync(teamDir);
	mkdirSync(teamHome);
	copyFileSync("install-team.sh", join(teamDir, "install-team.sh"));
	writeFileSync(join(teamDir, "install.sh"), `#!/bin/sh
printf 'TEAM_FEED=%s|%s|%s\\n' "$PRIME_AGENT_DOWNLOAD_BASE_URL" "$PRIME_AGENT_RELEASE_LAYOUT" "$1"
entry="$npm_config_prefix/lib/node_modules/prime-agent-team/dist/bundle/cli.js"
mkdir -p "$npm_config_prefix/bin" "\${entry%/*}"
printf 'console.log(process.execPath);\\n' > "$entry"
chmod +x "$entry"
`);
	const entry = spawnSync("sh", [join(teamDir, "install-team.sh"), version], {
		encoding: "utf-8",
		env: { HOME: teamHome, PATH: `/usr/bin${delimiter}/bin`, PRIME_AGENT_TEAM_NODE: process.execPath, PRIME_AGENT_TEAM_GITHUB_REPO: "owner/repo" },
	});
	check(entry.status === 0 && entry.stdout.includes("TEAM_FEED=https://github.com/owner/repo|github|0.9.8+fork.4"), `GitHub Team entrypoint failed: ${entry.stdout}${entry.stderr}`);
	if (entry.status === 0) {
		const wrapper = join(teamHome, ".local/bin/prime-agent-team");
		const runtime = join(teamHome, ".local/share/prime-agent-team/node-path");
		const result = spawnSync(wrapper, ["--version"], { encoding: "utf-8", env: { HOME: teamHome, PATH: `/usr/bin${delimiter}/bin` } });
		check(result.status === 0 && result.stdout.trim() === process.execPath, `Team wrapper must use the saved Node even when it is not on PATH: ${result.stderr}`);
		writeFileSync(runtime, "/missing/team-node\n");
		const missing = spawnSync(wrapper, [], { encoding: "utf-8", env: { HOME: teamHome, PATH: `/usr/bin${delimiter}/bin` } });
		check(missing.status !== 0 && missing.stderr.includes("PRIME_AGENT_TEAM_NODE"), "missing Node must report a repair action");
		const update = spawnSync("sh", [join(teamDir, "install-team.sh"), version], {
			encoding: "utf-8", env: { HOME: teamHome, PATH: `/usr/bin${delimiter}/bin`, PRIME_AGENT_TEAM_NODE: process.execPath, PRIME_AGENT_TEAM_GITHUB_REPO: "owner/repo" },
		});
		check(update.status === 0 && readFileSync(runtime, "utf-8").trim() === process.execPath, `managed wrapper update failed: ${update.stderr}`);
		const managed = join(teamHome, ".local/share/prime-agent-team/bin/prime-agent-team");
		const changed = readFileSync(managed, "utf-8") + "# user change\n";
		writeFileSync(managed, changed);
		const refused = spawnSync("sh", [join(teamDir, "install-team.sh"), version], {
			encoding: "utf-8", env: { HOME: teamHome, PATH: `/usr/bin${delimiter}/bin`, PRIME_AGENT_TEAM_NODE: process.execPath, PRIME_AGENT_TEAM_GITHUB_REPO: "owner/repo" },
		});
		check(refused.status !== 0 && readFileSync(managed, "utf-8") === changed, "modified prefix wrapper must be preserved");
	}
	const legacyHome = join(tempDir, "team-legacy-symlink");
	const legacyPrefix = join(legacyHome, ".local/share/prime-agent-team");
	mkdirSync(join(legacyPrefix, "bin"), { recursive: true });
	writeFileSync(join(legacyPrefix, ".prime-agent-team-prefix-v1"), "prime-agent-team npm prefix v1\n");
	symlinkSync("../lib/node_modules/prime-agent-team/dist/bundle/cli.js", join(legacyPrefix, "bin/prime-agent-team"));
	const legacy = spawnSync("sh", [join(teamDir, "install-team.sh"), version], {
		encoding: "utf-8", env: { HOME: legacyHome, PATH: `/usr/bin${delimiter}/bin`, PRIME_AGENT_TEAM_NODE: process.execPath, PRIME_AGENT_TEAM_GITHUB_REPO: "owner/repo" },
	});
	check(legacy.status === 0 && readFileSync(join(legacyPrefix, "bin/prime-agent-team"), "utf-8").includes("prime-agent-team-managed-wrapper-v1"), `legacy Team symlink upgrade failed: ${legacy.stderr}`);
	const specialHome = join(tempDir, "home ' ;$(touch TEAM_HOME_PWNED)");
	const specialNodeDir = join(tempDir, "node ' ;$(touch TEAM_NODE_PWNED)");
	mkdirSync(specialHome);
	mkdirSync(specialNodeDir);
	const specialNode = join(specialNodeDir, "node");
	symlinkSync(process.execPath, specialNode);
	symlinkSync(join(dirname(process.execPath), "npm"), join(specialNodeDir, "npm"));
	const special = spawnSync("sh", [join(teamDir, "install-team.sh"), version], {
		cwd: tempDir, encoding: "utf-8", env: { HOME: specialHome, PATH: `/usr/bin${delimiter}/bin`, PRIME_AGENT_TEAM_NODE: specialNode, PRIME_AGENT_TEAM_GITHUB_REPO: "owner/repo" },
	});
	const specialWrapper = join(specialHome, ".local/bin/prime-agent-team");
	const specialRun = special.status === 0 ? spawnSync(specialWrapper, ["--version"], { cwd: tempDir, encoding: "utf-8", env: { HOME: specialHome, PATH: `/usr/bin${delimiter}/bin` } }) : null;
	check(special.status === 0 && specialRun?.status === 0 && specialRun.stdout.trim() === process.execPath && !existsSync(join(tempDir, "TEAM_HOME_PWNED")) && !existsSync(join(tempDir, "TEAM_NODE_PWNED")), `special HOME or Node path must remain data: ${special.stderr}${specialRun?.stderr ?? ""}`);
	const conflictHome = join(tempDir, "team-existing-wrapper");
	const conflictBin = join(conflictHome, ".local/bin");
	mkdirSync(conflictBin, { recursive: true });
	const existing = join(conflictBin, "prime-agent-team");
	writeFileSync(existing, "#!/bin/sh\necho unrelated\n");
	chmodSync(existing, 0o755);
	const conflictResult = spawnSync("sh", [join(teamDir, "install-team.sh"), version], {
		encoding: "utf-8", env: { HOME: conflictHome, PATH: `/usr/bin${delimiter}/bin`, PRIME_AGENT_TEAM_NODE: process.execPath, PRIME_AGENT_TEAM_GITHUB_REPO: "owner/repo" },
	});
	check(conflictResult.status !== 0 && readFileSync(existing, "utf-8") === "#!/bin/sh\necho unrelated\n" && !existsSync(join(conflictHome, ".local/share/prime-agent-team")), "unmanaged wrapper must be preserved before installing");
	for (const repo of ["../bad", "owner/repo/extra", "owner/repo?x", "owner:bad/repo"]) {
		const result = spawnSync("sh", ["install-team.sh", "0.9.8+fork.4"], {
			encoding: "utf-8", env: { ...process.env, PRIME_AGENT_DOWNLOAD_BASE_URL: "", PRIME_AGENT_TEAM_RELEASE_LAYOUT: "standard", PRIME_AGENT_TEAM_GITHUB_REPO: repo },
		});
		check(result.status !== 0 && result.stderr.includes("invalid GitHub"), `invalid GitHub repository ${repo} must fail`);
	}
	for (const versionArg of ["0.9.8+../bad", "0.9.8++x", "stable", "01.2.3+build", "1.2.3-01+build"]) {
		const result = spawnSync(process.execPath, ["scripts/pack-prime-agent-release.mjs", "--github-flat", "--base-url", "https://example.test/repo", "--version", versionArg], { encoding: "utf-8" });
		check(result.status !== 0, `packer must reject GitHub version ${versionArg}`);
	}
	for (const baseUrl of ["http://example.test/repo", "https://user@example.test/repo", "https://example.test/repo?other=1"]) {
		const result = spawnSync(process.execPath, ["scripts/pack-prime-agent-release.mjs", "--github-flat", "--base-url", baseUrl, "--version", version], {
			encoding: "utf-8", env: { ...process.env, PRIME_AGENT_ALLOW_INSECURE_HTTP_FOR_TESTS: "0" },
		});
		check(result.status !== 0, `packer must reject untrusted base URL ${baseUrl}`);
	}
}

function checkVerifiedTeamPackages() {
	const root = join(tempDir, "verified-team");
	const scripts = join(root, "scripts");
	const bin = join(root, "bin");
	const feed = join(root, "feed");
	for (const directory of [scripts, bin, feed]) mkdirSync(directory, { recursive: true });
	copyFileSync("install.sh", join(scripts, "install.sh"));
	copyFileSync("install-team.sh", join(scripts, "install-team.sh"));
	const names = ["team", "ai", "core", "tui"];
	const version = "1.2.3";
	const filename = (name) => `prime-agent-${name}-${version}.tgz`;
	const content = (name) => `verified ${name} bytes`;
	const inventory = names.map((name) => {
		const bytes = content(name);
		writeFileSync(join(feed, filename(name)), bytes);
		return `${createHash("sha256").update(bytes).digest("hex")}  ${filename(name)}`;
	}).join("\n") + "\n";
	writeFileSync(join(feed, "SHA256SUMS"), inventory);
	const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
	writeFileSync(join(bin, "curl"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in -o) shift; output=$1 ;; http*) url=$1 ;; esac
  shift
done
cp ${quote(feed)}/"\${url##*/}" "$output"
`);
	writeFileSync(join(bin, "npm"), `#!/bin/sh
if [ "\${1:-}" = --version ]; then
  case "$HOME" in */home-npm12) echo 12.2.2 ;; *) echo 11.19.1 ;; esac
  exit 0
fi
[ "\${1:-}" = install ] || exit 1
case "$HOME" in */home-npm12)
  found=0
  for arg in "$@"; do
    case "$arg" in --allow-remote=all) found=1 ;; --allow-scripts*) exit 1 ;; esac
  done
  [ "$found" = 1 ] || exit 1 ;;
esac
printf 'install\\n' > "$HOME/npm-ran"
entry="$npm_config_prefix/lib/node_modules/prime-agent-team/dist/bundle/cli.js"
mkdir -p "\${entry%/*}"
printf '#!/bin/sh\\nexit 0\\n' > "$entry"
chmod +x "$entry"
`);
	chmodSync(join(bin, "curl"), 0o755);
	chmodSync(join(bin, "npm"), 0o755);
	symlinkSync(process.execPath, join(bin, "node"));
	for (const broken of ["none", "standard", "npm12", ...names, "duplicate", "missing"]) {
		const home = join(root, `home-${broken}`);
		const tampered = names.includes(broken);
		mkdirSync(home);
		if (tampered) writeFileSync(join(feed, filename(broken)), "tampered bytes");
		if (broken === "duplicate") writeFileSync(join(feed, "SHA256SUMS"), inventory + inventory.split("\n")[1] + "\n");
		if (broken === "missing") writeFileSync(join(feed, "SHA256SUMS"), inventory.split("\n").filter((line) => !line.endsWith(filename("ai"))).join("\n"));
		const result = spawnSync("sh", [join(scripts, "install-team.sh"), version], {
			encoding: "utf-8",
			env: { HOME: home, PATH: `${bin}${delimiter}${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`, TMPDIR: root, PRIME_AGENT_DOWNLOAD_BASE_URL: "https://example.test", PRIME_AGENT_TEAM_RELEASE_LAYOUT: broken === "standard" ? "standard" : "github" },
		});
		if (tampered) writeFileSync(join(feed, filename(broken)), content(broken));
		if (broken === "duplicate" || broken === "missing") writeFileSync(join(feed, "SHA256SUMS"), inventory);
		const installed = existsSync(join(home, "npm-ran"));
		if (tampered || broken === "duplicate" || broken === "missing") {
			check(result.status !== 0 && !installed, `invalid ${broken} must be rejected before npm install`);
			continue;
		}
		check(result.status === 0 && installed, `verified Team install failed: ${result.stderr}${result.stdout}`);
		if (installed) {
			const manifest = JSON.parse(readFileSync(join(home, ".local/share/prime-agent-team/lib/package.json"), "utf-8"));
			check(manifest.allowScripts?.["prime-agent-team"] === true, "Team postinstall must be explicitly allowed for npm 12");
			check(manifest.dependencies["prime-agent-team"].startsWith("file:") && manifest.dependencies["prime-agent-team"].endsWith(filename("team")), "Team package must use the verified local tarball");
			for (const [key, name] of [["@earendil-works/pi-ai", "ai"], ["@earendil-works/pi-agent-core", "core"], ["@earendil-works/pi-tui", "tui"]]) {
				check(manifest.overrides[key].startsWith("file:") && manifest.overrides[key].endsWith(filename(name)), `Team ${name} must use the verified local tarball`);
			}
		}
	}
	for (const conflict of ["symlink", "npmrc"]) {
		const home = join(root, `home-${conflict}`);
		const prefix = join(home, ".local/share/prime-agent-team");
		mkdirSync(prefix, { recursive: true });
		writeFileSync(join(prefix, ".prime-agent-team-prefix-v1"), "prime-agent-team npm prefix v1\n");
		if (conflict === "symlink") symlinkSync(feed, join(prefix, "lib"));
		else {
			mkdirSync(join(prefix, "lib"));
			writeFileSync(join(prefix, "lib/.npmrc"), "registry=https://example.test");
		}
		const result = spawnSync("sh", [join(scripts, "install-team.sh"), version], {
			encoding: "utf-8", env: { HOME: home, PATH: `${bin}${delimiter}${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`, TMPDIR: root, PRIME_AGENT_DOWNLOAD_BASE_URL: "https://example.test" },
		});
		check(result.status !== 0 && !existsSync(join(home, "npm-ran")), `unmanaged ${conflict} must be rejected before npm install`);
	}
}

function checkNpmInstallPolicies() {
	const binDir = join(tempDir, "bin");
	const installHarnessPath = join(tempDir, "install-harness.sh");
	const npmPath = join(binDir, "npm");
	const tarballPath = join(tempDir, "verified release package.tgz");
	const installHarnessSource = `${installerSource.slice(0, mainCallIndex)}

prime_agent_npm_install "$1"
`;
	const npmSource = `#!/bin/sh
set -eu

if [ "\${1:-}" = "--version" ]; then
	printf '%s\\n' "$FAKE_NPM_VERSION"
	exit 0
fi
[ "\${1:-}" = install ] || exit 1

remote_policy=
script_policy=
target=
for arg in "$@"; do
	case "$arg" in
		--allow-remote=*) remote_policy=\${arg#*=} ;;
		--allow-scripts=*) script_policy=\${arg#*=} ;;
		"$FAKE_NPM_TARBALL") target="$arg" ;;
	esac
done
[ "$target" = "$FAKE_NPM_TARBALL" ] || exit 1

npm_major=\${FAKE_NPM_VERSION%%.*}
if [ "$npm_major" -ge 12 ]; then
	[ "$remote_policy" = all ] && [ "$script_policy" = "$FAKE_NPM_TARBALL" ] || exit 1
else
	[ -z "$remote_policy" ] && [ -z "$script_policy" ] || exit 1
fi
`;

	mkdirSync(binDir);
	writeFileSync(installHarnessPath, installHarnessSource, "utf-8");
	writeFileSync(npmPath, npmSource, "utf-8");
	writeFileSync(tarballPath, "verified fixture", "utf-8");
	chmodSync(npmPath, 0o755);

	for (const npmVersion of ["10.9.8", "11.12.1", "12.0.2"]) {
		const result = spawnSync("sh", [installHarnessPath, tarballPath], {
			encoding: "utf-8",
			env: {
				...process.env,
				FAKE_NPM_TARBALL: tarballPath,
				FAKE_NPM_VERSION: npmVersion,
				PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
			},
		});
		if (result.status !== 0) {
			failures.push(`npm ${npmVersion}: install policy check failed\n${result.stderr}${result.stdout}`);
		}
	}
}

function runCase(name, initialCols, initialRows, resizedCols, resizedRows) {
	const result = spawnSync("sh", [harnessPath, String(initialCols), String(initialRows), String(resizedCols), String(resizedRows)], {
		detached: true,
		encoding: "utf-8",
	});
	if (result.status !== 0) {
		failures.push(`${name}: harness exited with ${result.status ?? "unknown"}\n${result.stderr}${result.stdout}`);
		return emptyParsedCase();
	}

	const parsed = parseRenderOutput(result.stdout);
	parsed.screens = parseScreenOutput(result.stderr);
	assertLineWidths(name, "first", parsed, initialCols, initialRows);
	assertLineWidths(name, "second", parsed, resizedCols, resizedRows);
	assertScreenFrame(name, "first", parsed, initialCols, initialRows);
	assertScreenFrame(name, "second", parsed, resizedCols, resizedRows);
	return parsed;
}

function parseRenderOutput(output) {
	const parsed = emptyParsedCase();
	let activeRender = null;

	for (const rawLine of output.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.startsWith("__META__ ")) {
			const [, label, ...fields] = line.split(" ");
			parsed.meta[label] = Object.fromEntries(fields.map((field) => field.split("=")));
			continue;
		}
		if (line.startsWith("__RENDER_START__ ")) {
			activeRender = line.slice("__RENDER_START__ ".length);
			parsed.renders[activeRender] = [];
			continue;
		}
		if (line.startsWith("__RENDER_END__ ")) {
			activeRender = null;
			continue;
		}
		if (line.startsWith("__PROGRESS__ ")) {
			const [frame, status, detail] = line.slice("__PROGRESS__ ".length).split("\t");
			parsed.progress.push({ frame: Number(frame), status, detail });
			continue;
		}
		if (activeRender) {
			parsed.renders[activeRender].push(line.replace(ansiPattern, ""));
		}
	}

	return parsed;
}

function parseScreenOutput(output) {
	const screens = {};
	for (const label of ["first", "second"]) {
		const startToken = `__SCREEN_START__ ${label}\n`;
		const endToken = `__SCREEN_END__ ${label}\n`;
		const startIndex = output.indexOf(startToken);
		if (startIndex === -1) {
			failures.push(`missing ${label} screen start marker`);
			continue;
		}
		const contentStart = startIndex + startToken.length;
		const endIndex = output.indexOf(endToken, contentStart);
		if (endIndex === -1) {
			failures.push(`missing ${label} screen end marker`);
			continue;
		}
		screens[label] = output.slice(contentStart, endIndex);
	}
	return screens;
}

function assertInstallerProgress(progress) {
	check(progress.length === 6, `expected six progress samples, got ${progress.length}`);
	if (progress.length !== 6) return;

	const expectedDetails = [
		"Preparing global install.",
		"Preparing global install.",
		"Linking command binaries.",
		"Linking command binaries.",
		"Finalizing npm install.",
		"Finalizing npm install.",
	];
	for (const [index, expectedDetail] of expectedDetails.entries()) {
		check(
			progress[index].detail === expectedDetail,
			`expected progress sample ${index + 1} to show "${expectedDetail}", got "${progress[index].detail}"`,
		);
		check(
			progress[index].status === "Installing Prime Agent...",
			`expected progress sample ${index + 1} to use indeterminate status`,
		);
		check(!progress[index].status.includes("%"), `expected progress sample ${index + 1} not to include a percent`);
	}
}

function assertLineWidths(name, label, parsed, cols, rows) {
	const lines = parsed.renders[label] ?? [];
	check(lines.length === rows, `${name}: expected ${label} render to have ${rows} rows, got ${lines.length}`);

	const maxWidth = Math.max(cols - 1, 0);
	for (const [index, line] of lines.entries()) {
		check(line.length <= maxWidth, `${name}: ${label} render line ${index + 1} reached ${line.length} columns in a ${cols}-column terminal`);
	}
}

function assertScreenFrame(name, label, parsed, cols, rows) {
	const screen = parsed.screens[label] ?? "";
	check(screen.endsWith(syncEnd), `${name}: expected ${label} screen frame to end with synchronized update close`);
	check(!screen.endsWith(`\n${syncEnd}`), `${name}: expected ${label} screen frame not to emit a trailing row newline`);
	check(countNewlines(screen) === rows - 1, `${name}: expected ${label} screen frame to contain ${rows - 1} line breaks`);

	const lines = screen.replace(ansiPattern, "").split("\n");
	check(lines.length === rows, `${name}: expected ${label} screen frame to contain ${rows} rows, got ${lines.length}`);
	const maxWidth = Math.max(cols - 1, 0);
	for (const [index, line] of lines.entries()) {
		check(line.length <= maxWidth, `${name}: ${label} screen line ${index + 1} reached ${line.length} columns in a ${cols}-column terminal`);
	}
}

function countNewlines(text) {
	let count = 0;
	for (const char of text) {
		if (char === "\n") count++;
	}
	return count;
}

function check(condition, message) {
	if (!condition) {
		failures.push(message);
	}
}

function emptyParsedCase() {
	return {
		meta: {
			first: {},
			second: {},
		},
		renders: {
			first: [],
			second: [],
		},
		screens: {},
		progress: [],
	};
}
