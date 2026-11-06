import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";

const aclProcess = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: aclProcess }));

import { nativeMeshConfigFromEnvironment } from "../src/modes/daemon/native-mesh/config.js";

const homes: string[] = [];
function home() {
	const dir = mkdtempSync(join(tmpdir(), "team-mesh-test-"));
	homes.push(dir);
	return dir;
}
function envFor(dir: string): NodeJS.ProcessEnv {
	return { HOME: dir, USERPROFILE: dir };
}
const config = { url: "http://127.0.0.1:123", token: "test-secret-value", machineId: "host" };
const completeEnv = {
	PRIME_AGENT_TEAM_MESH_URL: config.url,
	PRIME_AGENT_TEAM_MESH_TOKEN: config.token,
	PRIME_AGENT_TEAM_MACHINE_ID: config.machineId,
};
function writePrivate(path: string, data: string) {
	writeFileSync(path, data, { mode: 0o600 });
	if (process.platform !== "win32") chmodSync(path, 0o600);
}
afterEach(() => {
	for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("native mesh opt-in configuration", () => {
	it("is off without config, creates nothing, and rejects partial environment", () => {
		const dir = home();
		const env = envFor(dir);
		expect(nativeMeshConfigFromEnvironment(env)).toBeUndefined();
		expect(existsSync(join(dir, ".prime-team", "agent"))).toBe(false);
		expect(() => nativeMeshConfigFromEnvironment({ ...env, PRIME_AGENT_TEAM_MESH_URL: config.url })).toThrow(
			"all three",
		);
		expect(() => nativeMeshConfigFromEnvironment({ ...env, ...completeEnv, PRIME_AGENT_TEAM_MESH_URL: "" })).toThrow(
			"all three",
		);
	});
	it("complete environment takes precedence without touching even an invalid explicit file", () => {
		const env = { ...envFor(home()), ...completeEnv, PRIME_AGENT_TEAM_MESH_CONFIG: "/missing/private" };
		expect(nativeMeshConfigFromEnvironment(env)).toEqual(config);
		expect(
			nativeMeshConfigFromEnvironment({ ...env, PRIME_AGENT_TEAM_MESH_URL: "https://example.com" }),
		).toBeDefined();
		for (const override of [
			{ PRIME_AGENT_TEAM_MESH_URL: "http://test-secret-value.example" },
			{ PRIME_AGENT_TEAM_MACHINE_ID: "test-secret-value\n" },
		]) {
			expect(() => nativeMeshConfigFromEnvironment({ ...env, ...override })).toThrow();
			try {
				nativeMeshConfigFromEnvironment({ ...env, ...override });
				throw new Error("expected failure");
			} catch (error) {
				expect(String(error)).not.toContain(config.token);
			}
		}
	});
	it("reports missing explicit paths without leaking their contents", () => {
		expect(() =>
			nativeMeshConfigFromEnvironment({ ...envFor(home()), PRIME_AGENT_TEAM_MESH_CONFIG: "test-secret-value" }),
		).toThrow("Cannot read");
		try {
			nativeMeshConfigFromEnvironment({ ...envFor(home()), PRIME_AGENT_TEAM_MESH_CONFIG: "test-secret-value" });
		} catch (error) {
			expect(String(error)).not.toContain("test-secret-value");
		}
	});
	it("uses Windows ACL verification and rejects unsafe or unknown results", () => {
		const dir = home();
		const path = join(dir, "mesh.json");
		writePrivate(path, JSON.stringify(config));
		const env = { ...envFor(dir), PRIME_AGENT_TEAM_MESH_CONFIG: path };
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		try {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			aclProcess.mockReturnValue({ status: 0, stdout: "OK\n" });
			expect(nativeMeshConfigFromEnvironment(env)).toEqual(config);
			aclProcess.mockReturnValue({ status: 0, stdout: "UNSAFE\n" });
			expect(() => nativeMeshConfigFromEnvironment(env)).toThrow("unsafe Windows ACL");
			aclProcess.mockReturnValue({ status: null, stdout: null });
			expect(() => nativeMeshConfigFromEnvironment(env)).toThrow("security cannot be verified");
			expect(nativeMeshConfigFromEnvironment({ ...env, ...completeEnv })).toEqual(config);
		} finally {
			Object.defineProperty(process, "platform", platform);
			aclProcess.mockReset();
		}
	});
	// test-policy: allow conditional-or-disabled-test -- Unix concurrent workers require owner-only mode; Windows ACL branch is tested separately.
	it.skipIf(process.platform === "win32")(
		"loads default and explicit paths without creating an agent directory",
		async () => {
			const dir = home();
			const team = join(dir, ".prime-team");
			mkdirSync(team);
			const path = join(team, "envinhands-mesh.json");
			writePrivate(path, JSON.stringify(config));
			const env = envFor(dir);
			expect(nativeMeshConfigFromEnvironment(env)).toEqual(config);
			expect(nativeMeshConfigFromEnvironment({ ...env, PRIME_AGENT_TEAM_MESH_CONFIG: path })).toEqual(config);
			expect(existsSync(join(team, "agent"))).toBe(false);
			// Independent Node workers exercise simultaneous reads of the same file.
			const moduleUrl = new URL("../src/modes/daemon/native-mesh/team-config.ts", import.meta.url).href;
			const script = `const { parentPort, workerData } = require("node:worker_threads");
				import(workerData.moduleUrl).then(({ readTeamMeshConfig }) => {
					parentPort.postMessage(readTeamMeshConfig(workerData.env));
				}).catch(error => { throw error; });`;
			const results = await Promise.all(
				Array.from(
					{ length: 4 },
					() =>
						new Promise((resolve, reject) => {
							const worker = new Worker(script, {
								eval: true,
								execArgv: ["--import", "tsx"],
								workerData: { moduleUrl, env },
							});
							worker.once("message", resolve);
							worker.once("error", reject);
						}),
				),
			);
			expect(results).toEqual(Array(4).fill(config));
		},
	);
	// test-policy: allow conditional-or-disabled-test -- These file-content checks use Unix mode; Windows ACL verification is tested separately.
	it.skipIf(process.platform === "win32")(
		"rejects partial, malformed and oversized files without exposing secrets",
		() => {
			const dir = home();
			const path = join(dir, "mesh.json");
			const env = { ...envFor(dir), PRIME_AGENT_TEAM_MESH_CONFIG: path };
			for (const [data, message] of [
				[JSON.stringify({ url: config.url, token: config.token }), "url, token and machineId"],
				[`${config.token}{`, "valid JSON"],
				[JSON.stringify({ ...config, url: "http://secret.example" }), "Invalid native mesh URL or token"],
				["x".repeat(16385) + config.token, "16 KiB"],
			]) {
				writePrivate(path, data);
				try {
					nativeMeshConfigFromEnvironment(env);
					throw new Error("expected failure");
				} catch (error) {
					expect(String(error)).toContain(message);
					expect(String(error)).not.toContain(config.token);
				}
			}
		},
	);
	// test-policy: allow conditional-or-disabled-test -- Unix chmod and symlink semantics do not apply to Windows ACLs.
	it.skipIf(process.platform === "win32")("rejects symlinks, directories and non-owner-only permissions", () => {
		const dir = home();
		const path = join(dir, "mesh.json");
		const env = { ...envFor(dir), PRIME_AGENT_TEAM_MESH_CONFIG: path };
		writePrivate(path, JSON.stringify(config));
		chmodSync(path, 0o640);
		expect(() => nativeMeshConfigFromEnvironment(env)).toThrow("accessible only");
		chmodSync(path, 0o600);
		const link = join(dir, "link");
		symlinkSync(path, link);
		expect(() => nativeMeshConfigFromEnvironment({ ...env, PRIME_AGENT_TEAM_MESH_CONFIG: link })).toThrow("symlink");
		expect(() => nativeMeshConfigFromEnvironment({ ...env, PRIME_AGENT_TEAM_MESH_CONFIG: dir })).toThrow(
			"regular file",
		);
	});
});
