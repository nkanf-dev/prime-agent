/** One-way, first-run import of portable Prime Agent configuration. */
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmdirSync,
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

function readPortableFile(path: string, name: string): Buffer | undefined {
	const stat = statOrMissing(path);
	if (!stat) return undefined;
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error(`Team bootstrap: ${name} is not a regular file; inspect the upstream configuration.`);
	// O_NOFOLLOW also protects against a final-component symlink swap where supported.
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
		const data = readFileSync(fd);
		let source = data.toString("utf8");
		if (name === "models.json") {
			// Match the custom-model loader's JSON-with-comments support.
			source = source
				.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
				.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
		}
		const parsed: unknown = JSON.parse(source);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object");
		if (name === "settings.json" && Object.hasOwn(parsed, "sessionDir")) {
			// A legacy custom session directory would defeat Team isolation.
			delete (parsed as Record<string, unknown>).sessionDir;
			return Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`);
		}
		return data;
	} finally {
		closeSync(fd);
	}
}

/** Call only for the Team default path, never for an explicit directory override. */
export function bootstrapTeamConfig(home: string): void {
	const parent = join(home, ".prime-team");
	const target = join(parent, "agent");
	const marker = join(parent, INCOMPLETE);
	const checkMarker = () => {
		if (statOrMissing(marker))
			throw new Error(
				"Team bootstrap: import is in progress or was interrupted. Inspect ~/.prime-team/agent and remove ~/.prime-team/.team-bootstrap-incomplete after repairing it; upstream data was not changed.",
			);
	};
	if (assertDirectory(parent)) {
		checkMarker();
		if (assertDirectory(target)) {
			checkMarker();
			return;
		}
	}
	const sourceParent = join(home, ".prime");
	const source = join(sourceParent, "agent");
	if (!assertDirectory(sourceParent) || !assertDirectory(source)) return;

	// Read and validate every input before creating a target. Never include file contents or parser errors in messages.
	const files = new Map<string, Buffer>();
	for (const name of PORTABLE_FILES) {
		try {
			const data = readPortableFile(join(source, name), name);
			if (data !== undefined) files.set(name, data);
		} catch {
			throw new Error(
				`Team bootstrap: cannot safely read or parse upstream ${name}. Fix it or set PRIME_AGENT_TEAM_CODING_AGENT_DIR to a separate configuration directory; upstream data was not changed.`,
			);
		}
	}
	if (!files.size) return;
	try {
		if (!assertDirectory(parent)) {
			try {
				mkdirSync(parent, { mode: 0o700 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			assertDirectory(parent);
		}
		// The exclusive marker exists before the target. Other Team startups reject
		// an in-progress or interrupted import, including after a process crash.
		const markerFd = openSync(marker, "wx", 0o600);
		closeSync(markerFd);
		const created: string[] = [];
		let ownsTarget = false;
		try {
			if (assertDirectory(target)) {
				unlinkSync(marker);
				return;
			}
			mkdirSync(target, { mode: 0o700 });
			ownsTarget = true;
			for (const [name, data] of files) {
				const fd = openSync(join(target, name), "wx", 0o600);
				created.push(name);
				try {
					writeFileSync(fd, data);
				} finally {
					closeSync(fd);
				}
			}
			unlinkSync(marker);
		} catch (error) {
			let cleaned = true;
			for (const name of created.reverse()) {
				try {
					unlinkSync(join(target, name));
				} catch {
					cleaned = false;
				}
			}
			if (ownsTarget && cleaned) {
				try {
					rmdirSync(target);
				} catch {
					cleaned = false;
				}
			}
			// Keep the marker if cleanup failed, so a later startup cannot mistake
			// a partial import for an existing, complete user configuration.
			if (cleaned) {
				try {
					unlinkSync(marker);
				} catch {}
			}
			throw error;
		}
	} catch {
		throw new Error(
			"Team bootstrap: could not safely create Team configuration. Inspect ~/.prime-team/agent and retry; upstream data was not changed.",
		);
	}
}
