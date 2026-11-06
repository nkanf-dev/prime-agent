/** Read-only upstream credential lookup for the default Team configuration. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthCredential } from "./auth-storage.js";

export function readUpstreamCredential(home: string, provider: string): AuthCredential | undefined {
	try {
		for (const path of [join(home, ".prime"), join(home, ".prime", "agent")]) {
			const stat = lstatSync(path);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe directory");
		}
		const path = join(home, ".prime", "agent", "auth.json");
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("unsafe file");
		const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const opened = fstatSync(fd);
			if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev)
				throw new Error("file changed");
			const data: unknown = JSON.parse(readFileSync(fd, "utf8"));
			if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid object");
			if (!Object.hasOwn(data, provider)) return undefined;
			const credential: unknown = (data as Record<string, unknown>)[provider];
			if (!credential || typeof credential !== "object") throw new Error("invalid credential");
			const entry = credential as Record<string, unknown>;
			if (entry.type === "api_key" && typeof entry.key === "string") return credential as AuthCredential;
			if (
				entry.type === "oauth" &&
				typeof entry.access === "string" &&
				typeof entry.refresh === "string" &&
				typeof entry.expires === "number" &&
				Number.isFinite(entry.expires)
			)
				return credential as AuthCredential;
			// MCP tokens are intentionally not overlaid across applications.
			if (entry.type === "mcp_static_token") return undefined;
			throw new Error("invalid credential");
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(
			"Team auth: cannot safely read upstream auth.json; inspect its format and links. Upstream data was not changed.",
		);
	}
}
