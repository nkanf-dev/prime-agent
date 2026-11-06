/** One-way import of portable Prime Agent configuration. */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const PORTABLE_FILES = ["settings.json", "models.json", "keybindings.json", "mcp-connections.json"] as const;
const INCOMPLETE = ".team-bootstrap-incomplete";
// The marker is never removed by a waiter. A crashed owner requires manual recovery.
const MARKER_WAIT_MS = 10_000;
const MARKER_POLL_MS = 20;
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const MARKER_ERROR =
	"Team bootstrap: import is in progress or interrupted. After stopping Team processes, inspect ~/.prime-team/agent and remove ~/.prime-team/.team-bootstrap-incomplete to resume; upstream data was not changed.";

function waitForMarker(deadline: number): void {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new Error(MARKER_ERROR);
	Atomics.wait(waitCell, 0, 0, Math.min(MARKER_POLL_MS, remaining));
}

function statOrMissing(path: string) {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
function assertDirectory(path: string): boolean {
	const stat = statOrMissing(path);
	if (!stat) return false;
	if (stat.isSymbolicLink() || !stat.isDirectory())
		throw new Error("Team bootstrap: unsafe configuration directory; inspect the directory and remove any symlinks.");
	return true;
}
function readPortableFile(
	path: string,
	name: string,
	source: boolean,
): { data: Buffer; parsed: Record<string, unknown> } | undefined {
	const stat = statOrMissing(path);
	if (!stat) return undefined;
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("not a private regular file");
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev)
			throw new Error("file changed");
		if (opened.size > 8 * 1024 * 1024) throw new Error("file too large");
		const bytes = Buffer.allocUnsafe(opened.size + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const count = readSync(fd, bytes, offset, bytes.length - offset, null);
			if (count === 0) break;
			offset += count;
		}
		if (offset !== opened.size) throw new Error("file changed while reading");
		const data = bytes.subarray(0, offset);
		let text = data.toString("utf8");
		if (name === "models.json")
			text = text
				.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
				.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object");
		const object = parsed as Record<string, unknown>;
		if (source && name === "settings.json" && Object.hasOwn(object, "sessionDir")) {
			delete object.sessionDir;
			return { data: Buffer.from(`${JSON.stringify(object, null, 2)}\n`), parsed: object };
		}
		return { data, parsed: object };
	} finally {
		closeSync(fd);
	}
}

function ensureDirectory(path: string): void {
	if (assertDirectory(path)) return;
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	if (!assertDirectory(path)) throw new Error("directory unavailable");
}

/** Call only for the Team default path, never for an explicit directory override. */
export function bootstrapTeamConfig(home: string): void {
	const parent = join(home, ".prime-team");
	const target = join(parent, "agent");
	const sourceParent = join(home, ".prime");
	const source = join(sourceParent, "agent");
	const marker = join(parent, INCOMPLETE);
	const deadline = Date.now() + MARKER_WAIT_MS;
	if (assertDirectory(parent)) {
		while (statOrMissing(marker)) waitForMarker(deadline);
		if (assertDirectory(target)) {
			const auth = statOrMissing(join(target, "auth.json"));
			if (auth && (!auth.isFile() || auth.isSymbolicLink() || auth.nlink !== 1))
				throw new Error("Team bootstrap: unsafe Team auth.json; inspect links before retrying.");
		}
	}
	if (!assertDirectory(sourceParent) || !assertDirectory(source)) return;
	const readPair = (name: string) => {
		try {
			const existing = readPortableFile(join(target, name), name, false);
			// Existing files are user-owned; missing credentials use the read-only overlay.
			const upstream = existing ? undefined : readPortableFile(join(source, name), name, true);
			return { existing, upstream };
		} catch {
			throw new Error(
				`Team bootstrap: cannot safely read or parse ${name}; inspect upstream and Team files, then retry. No existing files were overwritten.`,
			);
		}
	};
	// Validate a complete configuration without acquiring the marker. Recheck the marker
	// after the scan so an import already in progress cannot be mistaken for completion.
	if (assertDirectory(parent) && assertDirectory(target)) {
		for (;;) {
			while (statOrMissing(marker)) waitForMarker(deadline);
			let needsImport = false;
			try {
				for (const name of PORTABLE_FILES) {
					const { existing, upstream } = readPair(name);
					if (!existing && upstream) needsImport = true;
				}
			} catch (error) {
				if (statOrMissing(marker)) continue;
				throw error;
			}
			if (statOrMissing(marker)) continue;
			if (!needsImport) return;
			break;
		}
	}
	try {
		ensureDirectory(parent);
	} catch {
		throw new Error(
			"Team bootstrap: cannot safely create Team configuration directory; upstream data was not changed.",
		);
	}
	let markerFd: number;
	for (;;) {
		try {
			markerFd = openSync(marker, "wx", 0o600);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(MARKER_ERROR);
			waitForMarker(deadline);
		}
	}
	closeSync(markerFd);
	try {
		ensureDirectory(target);
		for (const name of PORTABLE_FILES) {
			const { existing, upstream } = readPair(name);
			if (existing || !upstream) continue;
			// Hard-link publication is atomic and fails if a competing writer created the target.
			const temporary = join(target, `.team-bootstrap-${randomUUID()}.tmp`);
			let fd: number | undefined;
			try {
				fd = openSync(temporary, "wx", 0o600);
				writeFileSync(fd, upstream.data);
				fsyncSync(fd);
				closeSync(fd);
				fd = undefined;
				try {
					linkSync(temporary, join(target, name));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					// A concurrent writer won; never overwrite it. Reject unsafe links.
					readPortableFile(join(target, name), name, false);
				}
			} finally {
				if (fd !== undefined) closeSync(fd);
				if (statOrMissing(temporary)) unlinkSync(temporary);
			}
		}
	} finally {
		// Published files are complete and never rolled back; a retry fills remaining files.
		unlinkSync(marker);
	}
}
