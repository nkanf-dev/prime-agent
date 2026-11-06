import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { bootstrapTeamConfig } from "../src/team-bootstrap.js";

const homes: string[] = [];
function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "team-bootstrap-"));
	homes.push(dir);
	return dir;
}
function upstream(dir: string, name: string, data: string): void {
	const parent = join(dir, ".prime", "agent");
	mkdirSync(parent, { recursive: true });
	writeFileSync(join(parent, name), data);
}
afterEach(() => {
	for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("Team configuration bootstrap", () => {
	test("imports only portable config, privately, once without changing upstream", () => {
		const dir = home();
		const secret = "FAKE_API_KEY_NEVER_LOG";
		const settings = JSON.stringify({
			defaultProvider: "example",
			defaultModel: "x",
			skills: ["/my/skill"],
			sessionDir: "/main/sessions",
		});
		upstream(dir, "settings.json", settings);
		upstream(dir, "models.json", '{ // comment\n "providers": {},\n}');
		upstream(dir, "auth.json", JSON.stringify({ example: { type: "api_key", key: secret } }));
		upstream(dir, "keybindings.json", "{}");
		upstream(dir, "mcp-connections.json", "{}");
		upstream(dir, "daemon.sock", "must-not-copy");
		upstream(dir, "session.json", "must-not-copy");
		bootstrapTeamConfig(dir);
		const target = join(dir, ".prime-team", "agent");
		expect(JSON.parse(readFileSync(join(target, "settings.json"), "utf8"))).toEqual({
			defaultProvider: "example",
			defaultModel: "x",
			skills: ["/my/skill"],
		});
		expect(readFileSync(join(target, "auth.json"), "utf8")).toContain(secret);
		expect(existsSync(join(target, "daemon.sock"))).toBe(false);
		expect(existsSync(join(target, "session.json"))).toBe(false);
		if (process.platform !== "win32") {
			expect(lstatSync(target).mode & 0o777).toBe(0o700);
			expect(lstatSync(join(target, "auth.json")).mode & 0o777).toBe(0o600);
		}
		writeFileSync(join(target, "settings.json"), "{}");
		bootstrapTeamConfig(dir);
		expect(readFileSync(join(target, "settings.json"), "utf8")).toBe("{}");
		expect(readFileSync(join(dir, ".prime", "agent", "settings.json"), "utf8")).toBe(settings);
	});
	test("existing empty Team directory receives missing configuration", () => {
		const dir = home();
		upstream(dir, "settings.json", "{}");
		mkdirSync(join(dir, ".prime-team", "agent"), { recursive: true });
		bootstrapTeamConfig(dir);
		expect(readFileSync(join(dir, ".prime-team", "agent", "settings.json"), "utf8")).toBe("{}");
	});
	test("malformed source fails before target creation without disclosing contents", () => {
		const dir = home();
		upstream(dir, "auth.json", "SECRET-INVALID-");
		expect(() => bootstrapTeamConfig(dir)).toThrow(/auth.json/);
		try {
			bootstrapTeamConfig(dir);
		} catch (error) {
			expect(String(error)).not.toContain("SECRET-INVALID");
		}
		expect(existsSync(join(dir, ".prime-team", "agent", "auth.json"))).toBe(false);
	});
	// test-policy: allow conditional-or-disabled-test -- Windows symlink creation requires developer mode or elevated privilege; Linux CI exercises these checks.
	test.skipIf(process.platform === "win32")("refuses source and target symlinks", () => {
		const dir = home();
		upstream(dir, "settings.json", "{}");
		const src = join(dir, ".prime", "agent", "auth.json");
		symlinkSync(join(dir, ".prime", "agent", "settings.json"), src);
		expect(() => bootstrapTeamConfig(dir)).toThrow();
		rmSync(src);
		rmSync(join(dir, ".prime-team", "agent"), { recursive: true });
		symlinkSync(join(dir, ".prime", "agent"), join(dir, ".prime-team", "agent"));
		expect(() => bootstrapTeamConfig(dir)).toThrow();
	});
	test("existing Team files are preserved and empty auth has safe recovery", () => {
		const dir = home();
		const target = join(dir, ".prime-team", "agent");
		mkdirSync(target, { recursive: true });
		upstream(dir, "settings.json", JSON.stringify({ defaultModel: "upstream", sessionDir: "/upstream/sessions" }));
		upstream(dir, "models.json", JSON.stringify({ providers: { source: {} } }));
		upstream(dir, "auth.json", JSON.stringify({ source: { type: "api_key", key: "SECRET_SOURCE_482" } }));
		writeFileSync(join(target, "settings.json"), JSON.stringify({ defaultModel: "team" }));
		writeFileSync(join(target, "auth.json"), "{}");
		const warning = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			bootstrapTeamConfig(dir);
			expect(readFileSync(join(target, "settings.json"), "utf8")).toBe('{"defaultModel":"team"}');
			expect(JSON.parse(readFileSync(join(target, "models.json"), "utf8"))).toEqual({ providers: { source: {} } });
			expect(readFileSync(join(target, "auth.json"), "utf8")).toBe("{}");
			expect(warning).not.toHaveBeenCalled();
			expect(warning.mock.calls.flat().join(" ")).not.toContain("SECRET_SOURCE_482");
			renameSync(join(target, "auth.json"), join(target, "auth.backup.json"));
			bootstrapTeamConfig(dir);
			expect(JSON.parse(readFileSync(join(target, "auth.json"), "utf8"))).toEqual({
				source: { type: "api_key", key: "SECRET_SOURCE_482" },
			});
			expect(readFileSync(join(target, "auth.backup.json"), "utf8")).toBe("{}");
		} finally {
			warning.mockRestore();
		}
	});
	test("existing nonempty Team auth and models are never overwritten", () => {
		const dir = home();
		const target = join(dir, ".prime-team", "agent");
		mkdirSync(target, { recursive: true });
		upstream(
			dir,
			"auth.json",
			JSON.stringify({
				same: { type: "api_key", key: "MAIN_SECRET" },
				missing: { type: "api_key", key: "OTHER_SECRET" },
			}),
		);
		upstream(dir, "models.json", JSON.stringify({ providers: { main: {} } }));
		const teamAuth = JSON.stringify({ same: { type: "api_key", key: "TEAM_SECRET" } });
		const teamModels = JSON.stringify({ providers: { team: {} } });
		writeFileSync(join(target, "auth.json"), teamAuth);
		writeFileSync(join(target, "models.json"), teamModels);
		bootstrapTeamConfig(dir);
		expect(readFileSync(join(target, "auth.json"), "utf8")).toBe(teamAuth);
		expect(readFileSync(join(target, "models.json"), "utf8")).toBe(teamModels);
	});
	test("rejects source and destination hard links", () => {
		const dir = home();
		upstream(dir, "auth.json", "{}");
		const src = join(dir, ".prime", "agent", "auth.json");
		linkSync(src, join(dir, "source-hardlink"));
		expect(() => bootstrapTeamConfig(dir)).toThrow();
		rmSync(join(dir, "source-hardlink"));
		bootstrapTeamConfig(dir);
		const dest = join(dir, ".prime-team", "agent", "auth.json");
		linkSync(dest, join(dir, "target-hardlink"));
		expect(() => bootstrapTeamConfig(dir)).toThrow();
	});
	test("competing first launches never overwrite or expose partial files", async () => {
		const dir = home();
		upstream(dir, "settings.json", JSON.stringify({ defaultProvider: "test" }));
		upstream(dir, "auth.json", JSON.stringify({ test: { type: "api_key", key: "SYNTHETIC_CONCURRENT_SECRET" } }));
		const script = `import { bootstrapTeamConfig } from "./src/team-bootstrap.ts"; console.log("ready"); process.stdin.once("data", () => { try { bootstrapTeamConfig(process.env.HOME); } catch { process.exitCode = 1; } });`;
		const children = [1, 2].map(() =>
			spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
				cwd: process.cwd(),
				env: { ...process.env, HOME: dir },
				stdio: ["pipe", "pipe", "pipe"],
			}),
		);
		try {
			const outputs = children.map(() => "");
			const ready = children.map(
				(child, i) =>
					new Promise<void>((resolve, reject) => {
						child.stdout.on("data", (data: Buffer) => {
							outputs[i] += data.toString();
							if (outputs[i].includes("ready")) resolve();
						});
						child.stderr.on("data", (data: Buffer) => {
							outputs[i] += data.toString();
						});
						child.once("error", reject);
						child.once("exit", (code) => {
							if (!outputs[i].includes("ready")) reject(new Error(`child exited ${code}`));
						});
					}),
			);
			const exits = children.map(
				(child) =>
					new Promise<number | null>((resolve, reject) => {
						child.once("error", reject);
						child.once("exit", resolve);
					}),
			);
			await Promise.all(ready);
			children.forEach((child) => {
				child.stdin.end("go");
			});
			const statuses = await Promise.all(exits);
			expect(statuses).toContain(0);
			expect(statuses.every((status) => status === 0 || status === 1)).toBe(true);
			bootstrapTeamConfig(dir);
			expect(JSON.parse(readFileSync(join(dir, ".prime-team", "agent", "auth.json"), "utf8"))).toEqual({
				test: { type: "api_key", key: "SYNTHETIC_CONCURRENT_SECRET" },
			});
			expect(outputs.join("")).not.toContain("SYNTHETIC_CONCURRENT_SECRET");
		} finally {
			children.forEach((child) => {
				child.kill();
			});
		}
	});

	test("refuses to treat interrupted bootstrap as success", () => {
		const dir = home();
		const dest = join(dir, ".prime-team", "agent");
		mkdirSync(dest, { recursive: true });
		const marker = join(dir, ".prime-team", ".team-bootstrap-incomplete");
		upstream(dir, "settings.json", JSON.stringify({ defaultProvider: "recovered" }));
		writeFileSync(marker, "");
		expect(() => bootstrapTeamConfig(dir)).toThrow(/interrupted/);
		rmSync(marker);
		bootstrapTeamConfig(dir);
		expect(JSON.parse(readFileSync(join(dest, "settings.json"), "utf8"))).toEqual({ defaultProvider: "recovered" });
	});
	test("real CLI first launch and API consumers use imported model and auth without a model request", () => {
		const dir = home();
		const secret = "FAKE_INTEGRATION_CREDENTIAL_934";
		upstream(
			dir,
			"settings.json",
			JSON.stringify({ defaultProvider: "example", defaultModel: "sample", sessionDir: "/upstream/sessions" }),
		);
		upstream(dir, "auth.json", JSON.stringify({ example: { type: "api_key", key: secret } }));
		upstream(
			dir,
			"models.json",
			JSON.stringify({
				providers: {
					example: {
						baseUrl: "http://127.0.0.1:1/v1",
						api: "openai-completions",
						apiKey: "EXAMPLE_TEST_KEY",
						models: [{ id: "sample" }],
					},
				},
			}),
		);
		const env = {
			...process.env,
			HOME: dir,
			USERPROFILE: dir,
			TMPDIR: dir,
			PI_OFFLINE: "1",
			PRIME_AGENT_TEAM_CODING_AGENT_DIR: "",
			PRIME_AGENT_TEAM_SESSION_DIR: "",
			PRIME_AGENT_TEAM_CODING_AGENT_SESSION_DIR: "",
			PI_PACKAGE_DIR: "",
		};
		const cli = join(process.cwd(), "src", "cli.ts");
		const run = (args: string[], extraEnv = {}) =>
			spawnSync(process.execPath, ["--import", "tsx", ...args], {
				cwd: process.cwd(),
				env: { ...env, ...extraEnv },
				encoding: "utf8",
				timeout: 15000,
			});
		const first = run([cli, "--help"]);
		expect(first.status).toBe(0);
		expect(`${first.stdout}${first.stderr}`).not.toContain(secret);
		const target = join(dir, ".prime-team", "agent");
		expect(JSON.parse(readFileSync(join(target, "settings.json"), "utf8")).sessionDir).toBeUndefined();
		const probe = `
            import { getSessionsDir } from "./src/config.ts";
            import { join } from "node:path";
            import { SettingsManager } from "./src/core/settings-manager.ts";
            import { AuthStorage } from "./src/core/auth-storage.ts";
            import { ModelRegistry } from "./src/core/model-registry.ts";
            import { defaultDaemonSocketPath } from "./src/modes/daemon/daemon-socket.ts";
            const s = SettingsManager.create(process.env.HOME);
            const a = AuthStorage.create();
            const ok = s.getDefaultProvider() === "example" && s.getDefaultModel() === "sample" && s.getEnableBuiltinSkills() &&
                getSessionsDir() === join(process.env.HOME, ".prime-team", "agent", "sessions") &&
                await a.getApiKey("example") === process.env.EXPECTED_TEST_KEY &&
                !!ModelRegistry.create(a).find("example", "sample") && defaultDaemonSocketPath().includes("prime-agent-team");
            if (!ok) process.exit(2);
        `;
		const checked = run(["--input-type=module", "-e", probe], { EXPECTED_TEST_KEY: secret });
		expect(checked.status).toBe(0);
		expect(`${checked.stdout}${checked.stderr}`).not.toContain(secret);
	});
	test("CLI restart preserves Team config and explicit override bypasses import", () => {
		const dir = home();
		upstream(dir, "settings.json", JSON.stringify({ defaultProvider: "example" }));
		upstream(dir, "auth.json", JSON.stringify({ example: { type: "api_key", key: "FAKE_OVERRIDE_KEY" } }));
		bootstrapTeamConfig(dir);
		const target = join(dir, ".prime-team", "agent");
		const env = {
			...process.env,
			HOME: dir,
			USERPROFILE: dir,
			TMPDIR: dir,
			PI_OFFLINE: "1",
			PRIME_AGENT_TEAM_CODING_AGENT_DIR: "",
			PRIME_AGENT_TEAM_SESSION_DIR: "",
			PRIME_AGENT_TEAM_CODING_AGENT_SESSION_DIR: "",
			PI_PACKAGE_DIR: "",
		};
		const cli = join(process.cwd(), "src", "cli.ts");
		const run = (extraEnv = {}) =>
			spawnSync(process.execPath, ["--import", "tsx", cli, "--help"], {
				cwd: process.cwd(),
				env: { ...env, ...extraEnv },
				encoding: "utf8",
				timeout: 15000,
			});
		writeFileSync(join(target, "settings.json"), "{}");
		const second = run();
		expect(second.status).toBe(0);
		expect(readFileSync(join(target, "settings.json"), "utf8")).toBe("{}");
		const override = join(dir, "custom-team");
		const custom = run({ PRIME_AGENT_TEAM_CODING_AGENT_DIR: override });
		expect(custom.status).toBe(0);
		expect(existsSync(join(override, "auth.json"))).toBe(false);
		expect(readFileSync(join(target, "settings.json"), "utf8")).toBe("{}");
	});
});
