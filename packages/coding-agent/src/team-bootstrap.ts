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
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const PORTABLE_FILES = [
	"settings.json",
	"models.json",
	"auth.json",
	"keybindings.json",
	"mcp-connections.json",
] as const;
const INCOMPLETE = ".team-bootstrap-incomplete";

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
		const data = readFileSync(fd);
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
	if (assertDirectory(parent)) {
		if (statOrMissing(marker))
			throw new Error(
				"Team bootstrap: import is in progress or interrupted. After stopping Team processes, inspect ~/.prime-team/agent and remove ~/.prime-team/.team-bootstrap-incomplete to resume; upstream data was not changed.",
			);
		assertDirectory(target);
	}
	if (!assertDirectory(sourceParent) || !assertDirectory(source)) return;
	try {
		ensureDirectory(parent);
	} catch {
		throw new Error(
			"Team bootstrap: cannot safely create Team configuration directory; upstream data was not changed.",
		);
	}
	let markerFd: number;
	try {
		markerFd = openSync(marker, "wx", 0o600);
	} catch {
		throw new Error(
			"Team bootstrap: another import is in progress or interrupted. Stop Team processes and inspect ~/.prime-team/.team-bootstrap-incomplete before removing it to retry.",
		);
	}
	closeSync(markerFd);
	try {
		ensureDirectory(target);
		for (const name of PORTABLE_FILES) {
			let existing: ReturnType<typeof readPortableFile>;
			let upstream: ReturnType<typeof readPortableFile>;
			try {
				existing = readPortableFile(join(target, name), name, false);
				// Existing files are user-owned; missing credentials use the read-only overlay.
				if (!existing) upstream = readPortableFile(join(source, name), name, true);
			} catch {
				throw new Error(
					`Team bootstrap: cannot safely read or parse ${name}; inspect upstream and Team files, then retry. No existing files were overwritten.`,
				);
			}

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
