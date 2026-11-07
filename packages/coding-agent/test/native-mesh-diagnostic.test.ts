import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the package locator independent of the flag-check mock.
vi.mock("../src/config.js", () => ({ VERSION: "0.9.8+test" }));

// Mock only the synchronous flag check. Never create a real sentinel.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: vi.fn() };
});

// Force the Node temp flag to differ from /tmp, even on a Linux host.
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, tmpdir: vi.fn(actual.tmpdir) };
});

import { existsSync } from "node:fs";

type DiagnosticModule = typeof import("../src/modes/daemon/native-mesh/diagnostic.js");
let diagnostic: DiagnosticModule["nativeMeshDiagnostic"] | undefined;
let outputPath: string | undefined;
let tempDirectory: string;
const systemFlag = "/tmp/prime-team-native-mesh-diagnostic.enable";
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
}

function flagsPresent(...paths: string[]): void {
	vi.mocked(existsSync).mockImplementation((path) => paths.includes(String(path)));
}

async function loadDiagnostic(): Promise<DiagnosticModule> {
	const module = await import("../src/modes/daemon/native-mesh/diagnostic.js");
	diagnostic = module.nativeMeshDiagnostic;
	return module;
}

async function ready(): Promise<string | undefined> {
	outputPath = await diagnostic?.ready;
	return outputPath;
}

describe("native mesh diagnostic environment and flag", () => {
	beforeEach(async () => {
		vi.resetModules();
		vi.mocked(existsSync).mockReset();
		const actualOs = await vi.importActual<typeof import("node:os")>("node:os");
		tempDirectory = await mkdtemp(join(actualOs.tmpdir(), "native-mesh-flag-test-"));
		vi.mocked(tmpdir).mockReturnValue(tempDirectory);
		vi.stubEnv("PI_NATIVE_MESH_DIAGNOSTIC", undefined);
		vi.stubEnv("PI_NATIVE_MESH_DIAGNOSTIC_TTL_MS", undefined);
	});

	afterEach(async () => {
		// Even if an assertion fails, close and remove only the unique test directory.
		const path = outputPath ?? (await diagnostic?.ready);
		await diagnostic?.close();
		if (path) await rm(dirname(path), { recursive: true, force: true });
		await rm(tempDirectory, { recursive: true, force: true });
		diagnostic = undefined;
		outputPath = undefined;
		Object.defineProperty(process, "platform", platformDescriptor);
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it.each(["linux", "darwin", "win32"] as const)(
		"prefers the Node temp flag on %s and enables for 60 minutes",
		async (platform) => {
			setPlatform(platform);
			const flag = join(tempDirectory, "prime-team-native-mesh-diagnostic.enable");
			flagsPresent(flag, systemFlag);
			const timer = vi.spyOn(globalThis, "setTimeout");
			const module = await loadDiagnostic();
			expect(module.NATIVE_MESH_DIAGNOSTIC_FLAG).toBe(flag);
			expect(existsSync).not.toHaveBeenCalled(); // Lazy until the first diagnostic use.
			expect(await ready()).toBeTypeOf("string");
			expect(existsSync).toHaveBeenCalledExactlyOnceWith(flag);
			expect(timer).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);
			flagsPresent();
			expect(await diagnostic?.ready).toBe(outputPath);
			expect(existsSync).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["linux", "darwin"] as const)("falls back to /tmp on %s and enables for 60 minutes", async (platform) => {
		setPlatform(platform);
		flagsPresent(systemFlag);
		const timer = vi.spyOn(globalThis, "setTimeout");
		const module = await loadDiagnostic();
		expect(await ready()).toBeTypeOf("string");
		expect(vi.mocked(existsSync).mock.calls).toEqual([[module.NATIVE_MESH_DIAGNOSTIC_FLAG], [systemFlag]]);
		expect(timer).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);
	});

	it.each(["linux", "darwin"] as const)("is disabled when neither flag exists on %s", async (platform) => {
		setPlatform(platform);
		flagsPresent();
		const module = await loadDiagnostic();
		expect(await ready()).toBeUndefined();
		expect(vi.mocked(existsSync).mock.calls).toEqual([[module.NATIVE_MESH_DIAGNOSTIC_FLAG], [systemFlag]]);
	});

	it("does not check /tmp on Windows when the Node temp flag is absent", async () => {
		setPlatform("win32");
		flagsPresent(systemFlag);
		const module = await loadDiagnostic();
		expect(await ready()).toBeUndefined();
		expect(existsSync).toHaveBeenCalledExactlyOnceWith(module.NATIVE_MESH_DIAGNOSTIC_FLAG);
	});

	it.each(["0", "", "true", "2", " 1 "])("explicit env value %j disables even with flags", async (value) => {
		flagsPresent(join(tempDirectory, "prime-team-native-mesh-diagnostic.enable"), systemFlag);
		vi.stubEnv("PI_NATIVE_MESH_DIAGNOSTIC", value);
		vi.stubEnv("PI_NATIVE_MESH_DIAGNOSTIC_TTL_MS", "900000");
		await loadDiagnostic();
		expect(await ready()).toBeUndefined();
		expect(existsSync).not.toHaveBeenCalled();
	});

	it.each([undefined, "", "0", "3600001", "10000000", "-1", "1.5", "abc"])(
		"explicit enable with invalid TTL %j remains disabled even with flags",
		async (ttl) => {
			flagsPresent(join(tempDirectory, "prime-team-native-mesh-diagnostic.enable"), systemFlag);
			vi.stubEnv("PI_NATIVE_MESH_DIAGNOSTIC", "1");
			vi.stubEnv("PI_NATIVE_MESH_DIAGNOSTIC_TTL_MS", ttl);
			await loadDiagnostic();
			expect(await ready()).toBeUndefined();
			expect(existsSync).not.toHaveBeenCalled();
		},
	);

	it.each(["10000", "900000", "3600000"])("explicit enable uses valid TTL %s without reading flags", async (ttl) => {
		flagsPresent(join(tempDirectory, "prime-team-native-mesh-diagnostic.enable"), systemFlag);
		vi.stubEnv("PI_NATIVE_MESH_DIAGNOSTIC", "1");
		vi.stubEnv("PI_NATIVE_MESH_DIAGNOSTIC_TTL_MS", ttl);
		const timer = vi.spyOn(globalThis, "setTimeout");
		await loadDiagnostic();
		expect(await ready()).toBeTypeOf("string");
		expect(timer).toHaveBeenCalledWith(expect.any(Function), Number(ttl));
		expect(existsSync).not.toHaveBeenCalled();
	});

	it("writes the complete worker RPC error when enabled", async () => {
		flagsPresent(systemFlag);
		setPlatform("linux");
		await loadDiagnostic();
		const path = await ready();
		expect(path).toBeTypeOf("string");
		const workerError = "synthetic failure with full details";
		diagnostic!.record({ stage: "handoff", status: "failure", workerError });
		await diagnostic!.close();
		const records = (await readFile(path!, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records).toContainEqual(expect.objectContaining({ stage: "handoff", status: "failure", workerError }));
	});

	it.each(["node", "system"])("fails closed if the %s flag check throws", async (which) => {
		setPlatform("linux");
		vi.mocked(existsSync).mockImplementation((path) => {
			if ((which === "node" && String(path) !== systemFlag) || (which === "system" && String(path) === systemFlag)) {
				throw new Error("flag check failed");
			}
			return false;
		});
		const module = await loadDiagnostic();
		expect(await ready()).toBeUndefined();
		expect(vi.mocked(existsSync).mock.calls).toEqual(
			which === "node"
				? [[module.NATIVE_MESH_DIAGNOSTIC_FLAG]]
				: [[module.NATIVE_MESH_DIAGNOSTIC_FLAG], [systemFlag]],
		);
	});
});
