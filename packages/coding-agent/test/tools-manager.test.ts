import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toolState = vi.hoisted(() => ({
	toolsDir: `${process.env.TEMP ?? "/tmp"}/prime-tools-${process.pid}-${Math.random().toString(36).slice(2)}`,
	platform: "linux",
	architecture: "x64",
	extractZip: async (_source: string, _options: { dir: string }): Promise<void> => {},
}));

vi.mock("../src/config.js", () => ({
	APP_NAME: "prime-agent",
	getBinDir: () => toolState.toolsDir,
}));

vi.mock("os", () => ({
	arch: () => toolState.architecture,
	platform: () => toolState.platform,
}));

vi.mock("../src/utils/extract-tool-zip.js", () => ({
	extractToolZip: (source: string, directory: string) => toolState.extractZip(source, { dir: directory }),
}));

import { ensureToolWithStatus, getToolPath } from "../src/utils/tools-manager.js";

const originalPath = process.env.PATH;
let pathDir: string;
const originalOffline = process.env.PI_OFFLINE;

const writeNativeExecutable =
	process.platform === "win32"
		? (filePath: string, exitCode: number) => {
				if (exitCode === 0) copyFileSync(process.execPath, filePath);
				else writeFileSync(filePath, "invalid executable");
			}
		: (filePath: string, exitCode: number) => {
				writeFileSync(filePath, `#!/bin/sh\nexit ${exitCode}\n`, "utf8");
				chmodSync(filePath, 0o755);
			};
function writeExecutable(filePath: string, exitCode = 0): void {
	writeNativeExecutable(filePath, exitCode);
}

describe("tools manager", () => {
	beforeEach(() => {
		rmSync(toolState.toolsDir, { recursive: true, force: true });
		pathDir = join(toolState.toolsDir, "path");
		mkdirSync(pathDir, { recursive: true });
		process.env.PATH = pathDir;
		delete process.env.PI_OFFLINE;
		toolState.platform = process.platform;
		toolState.architecture = "x64";
		toolState.extractZip = async () => {};
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (originalOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = originalOffline;
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		rmSync(toolState.toolsDir, { recursive: true, force: true });
	});

	it("accepts managed and PATH tools only when their version check succeeds", () => {
		const managedPath = join(toolState.toolsDir, process.platform === "win32" ? "rg.exe" : "rg");
		writeExecutable(managedPath);
		expect(getToolPath("rg")).toBe(managedPath);

		writeExecutable(managedPath, 1);
		const pathBinary = join(pathDir, process.platform === "win32" ? "rg.exe" : "rg");
		writeExecutable(pathBinary);
		expect(getToolPath("rg")).toBe("rg");

		writeExecutable(pathBinary, 1);
		expect(getToolPath("rg")).toBeNull();
	});

	it.each([
		["reports a downloaded binary that passes its version check", 0, { status: "available" }, true],
		[
			"removes a downloaded binary that fails its version check",
			1,
			{ status: "unavailable", reason: "download_failed" },
			false,
		],
	])("%s", async (_label, extractedExitCode, expected, kept) => {
		toolState.platform = "win32";
		// A stale binary from an earlier run must not short-circuit the download.
		writeExecutable(join(toolState.toolsDir, "rg.exe"), 1);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ tag_name: "15.1.0" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		toolState.extractZip = async (_source, options) => {
			writeExecutable(join(options.dir, "rg.exe"), extractedExitCode);
		};

		await expect(ensureToolWithStatus("rg")).resolves.toMatchObject(expected);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(existsSync(join(toolState.toolsDir, "rg.exe"))).toBe(kept);
	});
});
