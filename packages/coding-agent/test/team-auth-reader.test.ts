import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { listUpstreamCredentials, readUpstreamCredential } from "../src/core/team-auth-overlay.js";

const homes: string[] = [];
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "team-auth-reader-"));
	homes.push(home);
	mkdirSync(join(home, ".prime", "agent"), { recursive: true });
	return { home, path: join(home, ".prime", "agent", "auth.json") };
}
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test("lists and reads model credentials but never service or MCP namespaces", () => {
	const { home, path } = fixture();
	const api = { type: "api_key", key: "FAKE_MODEL_KEY" };
	const oauth = { type: "oauth", access: "FAKE_ACCESS", refresh: "FAKE_REFRESH", expires: 9999999999999 };
	const body = JSON.stringify({
		model: api,
		subscription: oauth,
		serper: null,
		"mcp:example": { type: "api_key", key: 42 },
		static: { type: "mcp_static_token", bearer: "SECRET" },
	});
	writeFileSync(path, body);
	expect(readUpstreamCredential(home, "model")).toEqual(api);
	expect(readUpstreamCredential(home, "subscription")).toEqual(oauth);
	expect(readUpstreamCredential(home, "serper")).toBeUndefined();
	expect(readUpstreamCredential(home, "mcp:example")).toBeUndefined();
	expect(readUpstreamCredential(home, "static")).toBeUndefined();
	expect({ ...listUpstreamCredentials(home) }).toEqual({ model: api, subscription: oauth });
	expect(readFileSync(path, "utf8")).toBe(body);
});

test("missing, invalid, oversized and hardlinked files are safe", () => {
	const { home, path } = fixture();
	expect(readUpstreamCredential(home, "model")).toBeUndefined();
	expect({ ...listUpstreamCredentials(home) }).toEqual({});
	writeFileSync(path, "SECRET_INVALID_JSON");
	for (const operation of [() => readUpstreamCredential(home, "model"), () => listUpstreamCredentials(home)]) {
		try {
			operation();
			throw new Error("expected failure");
		} catch (error) {
			expect(String(error)).toMatch(/cannot safely read upstream/);
			expect(String(error)).not.toContain("SECRET_INVALID_JSON");
		}
	}
	writeFileSync(path, "{}");
	truncateSync(path, 8 * 1024 * 1024 + 1);
	expect(() => readUpstreamCredential(home, "model")).toThrow(/cannot safely read upstream/);
	writeFileSync(path, "{}");
	linkSync(path, join(home, "hard-link"));
	expect(() => listUpstreamCredentials(home)).toThrow(/cannot safely read upstream/);
});

// test-policy: allow conditional-or-disabled-test -- Unix ownership is not available on Windows.
test.skipIf(process.platform === "win32" || typeof process.getuid !== "function")(
	"rejects wrong owner at each file and directory check",
	() => {
		const { home, path } = fixture();
		writeFileSync(path, JSON.stringify({ model: { type: "api_key", key: "PRIVATE" } }));
		const uid = process.getuid?.() ?? 0;
		for (let target = 1; target <= 4; target++) {
			let calls = 0;
			const mock = vi.spyOn(process, "getuid").mockImplementation(() => (++calls === target ? uid + 1 : uid));
			try {
				expect(() => readUpstreamCredential(home, "model")).toThrow(/cannot safely read upstream/);
				expect(calls).toBe(target);
			} finally {
				mock.mockRestore();
			}
		}
		expect(readUpstreamCredential(home, "model")?.type).toBe("api_key");
	},
);

// test-policy: allow conditional-or-disabled-test -- Windows may require elevation for symlink creation.
test.skipIf(process.platform === "win32")("rejects symlinked files and directories", () => {
	const { home, path } = fixture();
	const other = join(home, "other");
	writeFileSync(other, "{}");
	symlinkSync(other, path);
	expect(() => readUpstreamCredential(home, "model")).toThrow(/cannot safely read upstream/);
	rmSync(path);
	rmSync(join(home, ".prime", "agent"), { recursive: true });
	symlinkSync(home, join(home, ".prime", "agent"));
	expect(() => listUpstreamCredentials(home)).toThrow(/cannot safely read upstream/);
});

test("reads only complete snapshots while a separate process atomically replaces auth", async () => {
	const { home, path } = fixture();
	const first = JSON.stringify({ model: { type: "api_key", key: "A" } });
	writeFileSync(path, first);
	const writer = `const fs = require("node:fs"); const path = process.argv[1]; process.stdout.write("ready\\n"); for (let i = 0; i < 3000; i++) { const tmp = path + ".next"; fs.writeFileSync(tmp, JSON.stringify({model:{type:"api_key",key:i % 2 ? "A" : "B"}})); fs.renameSync(tmp, path); }`;
	const child = spawn(process.execPath, ["-e", writer, path], { stdio: ["ignore", "pipe", "ignore"] });
	try {
		await once(child.stdout, "data");
		for (let i = 0; i < 3000; i++) {
			try {
				const credential = readUpstreamCredential(home, "model");
				expect(credential?.type).toBe("api_key");
				if (credential?.type === "api_key") expect(["A", "B"]).toContain(credential.key);
			} catch (error) {
				// Sustained contention can exhaust the bounded retries, but it must fail safely.
				expect(String(error)).toMatch(/cannot safely read upstream/);
			}
		}
		const exit = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", resolve);
		});
		expect(exit).toBe(0);
	} finally {
		child.kill();
	}
});
