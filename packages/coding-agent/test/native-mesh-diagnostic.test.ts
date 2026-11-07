import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the package locator independent of the flag-check mock.
vi.mock("../src/config.js", () => ({ VERSION: "0.9.8+test" }));

// Mock only the synchronous flag check. Real output goes into a unique mkdtemp directory.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: vi.fn() };
});

import { existsSync } from "node:fs";

type DiagnosticModule = typeof import("../src/modes/daemon/native-mesh/diagnostic.js");
let diagnostic: DiagnosticModule["nativeMeshDiagnostic"] | undefined;
let outputPath: string | undefined;

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
	beforeEach(() => {
		vi.resetModules();
		vi.mocked(existsSync).mockReset();
		vi.stubEnv("PI_NATIVE_MESH_DIAGNOSTIC", undefined);
		vi.stubEnv("PI_NATIVE_MESH_DIAGNOSTIC_TTL_MS", undefined);
	});

	afterEach(async () => {
		// Even if an assertion fails, close and remove the unique output directory.
		const path = outputPath ?? (await diagnostic?.ready);
		await diagnostic?.close();
		if (path) await rm(dirname(path), { recursive: true, force: true });
		diagnostic = undefined;
		outputPath = undefined;
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("enables for 15 minutes when the flag exists and env is absent", async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		const timer = vi.spyOn(globalThis, "setTimeout");
		const module = await loadDiagnostic();
		const flag = join(tmpdir(), "prime-team-native-mesh-diagnostic.enable");
		expect(module.NATIVE_MESH_DIAGNOSTIC_FLAG).toBe(flag);
		expect(existsSync).not.toHaveBeenCalled(); // Lazy until the first diagnostic use.
		expect(await ready()).toBeTypeOf("string");
		expect(existsSync).toHaveBeenCalledExactlyOnceWith(flag);
		expect(timer).toHaveBeenCalledWith(expect.any(Function), 15 * 60 * 1000);
		vi.mocked(existsSync).mockReturnValue(false);
		expect(await diagnostic?.ready).toBe(outputPath);
		expect(existsSync).toHaveBeenCalledTimes(1);
	});

	it("is disabled when the flag does not exist", async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		const module = await loadDiagnostic();
		expect(await ready()).toBeUndefined();
		expect(existsSync).toHaveBeenCalledExactlyOnceWith(module.NATIVE_MESH_DIAGNOSTIC_FLAG);
	});

	it.each(["0", "", "true", "2", " 1 "])("explicit env value %j disables even with a flag", async (value) => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.stubEnv("PI_NATIVE_MESH_DIAGNOSTIC", value);
		vi.stubEnv("PI_NATIVE_MESH_DIAGNOSTIC_TTL_MS", "900000");
		await loadDiagnostic();
		expect(await ready()).toBeUndefined();
		expect(existsSync).not.toHaveBeenCalled();
	});

	it.each([undefined, "", "0", "900001", "1000000", "-1", "1.5", "abc"])(
		"explicit enable with invalid TTL %j remains disabled even with a flag",
		async (ttl) => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.stubEnv("PI_NATIVE_MESH_DIAGNOSTIC", "1");
			vi.stubEnv("PI_NATIVE_MESH_DIAGNOSTIC_TTL_MS", ttl);
			await loadDiagnostic();
			expect(await ready()).toBeUndefined();
			expect(existsSync).not.toHaveBeenCalled();
		},
	);

	it.each(["10000", "900000"])("explicit enable uses valid TTL %s without reading the flag", async (ttl) => {
		vi.mocked(existsSync).mockReturnValue(false);
		vi.stubEnv("PI_NATIVE_MESH_DIAGNOSTIC", "1");
		vi.stubEnv("PI_NATIVE_MESH_DIAGNOSTIC_TTL_MS", ttl);
		const timer = vi.spyOn(globalThis, "setTimeout");
		await loadDiagnostic();
		expect(await ready()).toBeTypeOf("string");
		expect(timer).toHaveBeenCalledWith(expect.any(Function), Number(ttl));
		expect(existsSync).not.toHaveBeenCalled();
	});

	it("fails closed if the flag check throws", async () => {
		vi.mocked(existsSync).mockImplementation(() => {
			throw new Error("flag check failed");
		});
		await loadDiagnostic();
		expect(await ready()).toBeUndefined();
	});
});
