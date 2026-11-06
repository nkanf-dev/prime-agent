import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_CONFIG_BYTES = 16 * 1024;

// Node cannot inspect Windows ACLs. Ask the system PowerShell to check the DACL
// without passing the secret itself. Reject unresolved principals and failed checks.
function checkWindowsAcl(path: string): "ok" | "unsafe" | "unknown" {
	const script = `
$ErrorActionPreference = 'Stop'
try {
  $acl = Get-Acl -LiteralPath $env:PRIME_TEAM_ACL_PATH
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $owner = ([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($owner -ne $user -or -not $acl.AreAccessRulesProtected) { 'UNSAFE'; exit }
  $allowed = @($user, 'S-1-5-18', 'S-1-5-32-544')
  foreach ($rule in $acl.Access) {
    if ($rule.AccessControlType -eq 'Allow') {
      $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      if ($allowed -notcontains $sid) { 'UNSAFE'; exit }
    }
  }
  'OK'
} catch { 'UNKNOWN' }
`;
	const exe = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const result = spawnSync(
		exe,
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(script, "utf16le").toString("base64"),
		],
		{
			env: { ...process.env, PRIME_TEAM_ACL_PATH: path },
			encoding: "utf8",
			timeout: 5000,
			windowsHide: true,
			maxBuffer: 4096,
		},
	);
	if (result.status !== 0) return "unknown";
	const output = result.stdout.trim();
	return output === "OK" ? "ok" : output === "UNSAFE" ? "unsafe" : "unknown";
}

/** Read a private Team config without exposing its contents in errors. */
export function readTeamMeshConfig(env: NodeJS.ProcessEnv): unknown | undefined {
	const explicit = env.PRIME_AGENT_TEAM_MESH_CONFIG;
	if (explicit !== undefined && !explicit.trim())
		throw new Error("PRIME_AGENT_TEAM_MESH_CONFIG must be a non-empty path");
	const home = process.platform === "win32" ? env.USERPROFILE || homedir() : env.HOME || homedir();
	const path = explicit ?? join(home, ".prime-team", "envinhands-mesh.json");
	let fd: number | undefined;
	try {
		// lstat avoids following the final symlink; O_NOFOLLOW also closes the race on Unix.
		const before = lstatSync(path);
		if (before.isSymbolicLink()) throw new Error("symlink");
		const windows = process.platform === "win32";
		if (windows) {
			const acl = checkWindowsAcl(path);
			if (acl === "unsafe") throw new Error("windows-permissions");
			if (acl !== "ok") throw new Error("unverifiable");
		} else if (typeof process.getuid !== "function" || typeof constants.O_NOFOLLOW !== "number") {
			throw new Error("unverifiable");
		}
		fd = openSync(path, constants.O_RDONLY | (windows ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error("permissions");
		if (!windows && (stat.uid !== process.getuid?.() || (stat.mode & 0o7077) !== 0)) throw new Error("permissions");
		const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
		let used = 0;
		while (used < buffer.length) {
			const count = readSync(fd, buffer, used, buffer.length - used, null);
			if (count === 0) break;
			used += count;
		}
		if (used > MAX_CONFIG_BYTES) throw new Error("size");
		try {
			return JSON.parse(buffer.subarray(0, used).toString("utf8"));
		} catch {
			throw new Error("json");
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" && explicit === undefined) return undefined;
		const reason = error instanceof Error ? error.message : "";
		if (reason === "unverifiable")
			throw new Error(
				"Native mesh config file security cannot be verified on this platform; use PRIME_AGENT_TEAM_MESH_URL, PRIME_AGENT_TEAM_MESH_TOKEN and PRIME_AGENT_TEAM_MACHINE_ID instead",
			);
		if (reason === "symlink" || code === "ELOOP")
			throw new Error("Native mesh config must not be a symlink; replace it with a private regular file");
		if (reason === "windows-permissions")
			throw new Error(
				"Native mesh config has an unsafe Windows ACL; disable inheritance and grant access only to your user, SYSTEM and Administrators",
			);
		if (reason === "permissions")
			throw new Error(
				"Native mesh config must be a regular file owned by the current user and accessible only by that user (chmod 600)",
			);
		if (reason === "size") throw new Error("Native mesh config exceeds the 16 KiB limit");
		if (reason === "json") throw new Error("Native mesh config is not valid JSON");
		throw new Error("Cannot read native mesh config file; check the configured path and file access");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
