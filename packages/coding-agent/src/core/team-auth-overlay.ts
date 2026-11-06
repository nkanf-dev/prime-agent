/** Read-only upstream credential lookup for the default Team configuration. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { AuthCredential } from "./auth-storage.js";

const LIMIT = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const UNSAFE_MESSAGE =
	"Team auth: cannot safely read upstream auth.json; inspect its format and links. Upstream data was not changed.";

// These credentials belong to services and must not cross application boundaries,
// even when their on-disk type looks like an ordinary provider API key.
function isModelNamespace(provider: string): boolean {
	return !provider.startsWith("mcp:") && provider !== "serper" && provider !== "prime-agent-traces";
}

class ReadRace extends Error {}

function hasExpectedOwner(uid: number): boolean {
	return process.platform === "win32" || typeof process.getuid !== "function" || uid === process.getuid();
}

// Resolve links before opening, but never follow a link at the final open. An
// existing broken link is a safe-read error, not an absent optional config.
function resolveExisting(path: string): string {
	lstatSync(path); // A missing entry means the optional upstream file is absent.
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ReadRace();
		throw error;
	}
}

function lstatResolved(path: string): Stats {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ReadRace();
		throw error;
	}
}

function rejectTeamAlias(upstream: string, team: string): void {
	try {
		const resolved = realpathSync(team);
		const normalize = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
		if (normalize(upstream) === normalize(resolved)) throw new Error("upstream aliases Team");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function readData(home: string): Record<string, unknown> | undefined {
	let missing = false;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		try {
			let upstreamAgent = "";
			for (const path of [join(home, ".prime"), join(home, ".prime", "agent")]) {
				const resolved = resolveExisting(path);
				upstreamAgent = resolved;
				const stat = lstatResolved(resolved);
				if (!stat.isDirectory() || stat.isSymbolicLink() || !hasExpectedOwner(stat.uid))
					throw new Error("unsafe directory");
			}
			rejectTeamAlias(upstreamAgent, join(home, ".prime-team", "agent"));
			const path = resolveExisting(join(home, ".prime", "agent", "auth.json"));
			rejectTeamAlias(path, join(home, ".prime-team", "agent", "auth.json"));
			const stat = lstatResolved(path);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !hasExpectedOwner(stat.uid))
				throw new Error("unsafe file");
			let fd: number;
			try {
				fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ReadRace();
				throw error;
			}
			try {
				const opened = fstatSync(fd);
				// An atomic replacement can unlink the old inode between lstat and open.
				if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink === 0) throw new ReadRace();
				if (!opened.isFile() || opened.nlink !== 1 || !hasExpectedOwner(opened.uid)) throw new Error("unsafe file");
				if (opened.size > LIMIT) throw new Error("file too large");
				const bytes = Buffer.allocUnsafe(opened.size + 1);
				let offset = 0;
				while (offset < bytes.length) {
					const count = readSync(fd, bytes, offset, bytes.length - offset, null);
					if (count === 0) break;
					offset += count;
				}
				if (offset !== opened.size) throw new ReadRace();
				const data: unknown = JSON.parse(bytes.subarray(0, offset).toString("utf8"));
				if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid object");
				return data as Record<string, unknown>;
			} finally {
				closeSync(fd);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
				missing = true;
				continue;
			}
			if (error instanceof ReadRace) {
				missing = false;
				continue;
			}
			throw new Error(UNSAFE_MESSAGE);
		}
	}
	if (missing) return undefined;
	throw new Error(UNSAFE_MESSAGE);
}

function readCredential(value: unknown): AuthCredential | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(UNSAFE_MESSAGE);
	const entry = value as Record<string, unknown>;
	if (entry.type === "api_key" && typeof entry.key === "string") return value as AuthCredential;
	if (
		entry.type === "oauth" &&
		typeof entry.access === "string" &&
		typeof entry.refresh === "string" &&
		typeof entry.expires === "number" &&
		Number.isFinite(entry.expires)
	)
		return value as AuthCredential;
	if (entry.type === "mcp_static_token") return undefined;
	throw new Error(UNSAFE_MESSAGE);
}

export function readUpstreamCredential(home: string, provider: string): AuthCredential | undefined {
	if (!isModelNamespace(provider)) return undefined;
	const data = readData(home);
	if (!data || !Object.hasOwn(data, provider)) return undefined;
	return readCredential(data[provider]);
}

/** List eligible model credentials without reading or importing service credentials. */
export function listUpstreamCredentials(home: string): Record<string, AuthCredential> {
	const data = readData(home);
	const result: Record<string, AuthCredential> = Object.create(null);
	if (!data) return result;
	for (const [provider, value] of Object.entries(data)) {
		if (!isModelNamespace(provider)) continue;
		const credential = readCredential(value);
		if (credential) result[provider] = credential;
	}
	return result;
}
