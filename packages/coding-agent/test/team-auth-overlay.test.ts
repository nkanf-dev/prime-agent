import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSync } from "esbuild";
import { afterEach, expect, test } from "vitest";
import { readUpstreamCredential } from "../src/core/team-auth-overlay.js";

const homes: string[] = [];
function home() {
	const dir = mkdtempSync(join(tmpdir(), "team-auth-overlay-"));
	homes.push(dir);
	mkdirSync(join(dir, ".prime", "agent"), { recursive: true });
	mkdirSync(join(dir, ".prime-team", "agent"), { recursive: true });
	return dir;
}
afterEach(() => {
	for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("default Team reads main credentials without writing them, with live Team precedence and independent model fallback", () => {
	const dir = home();
	const source = join(dir, ".prime", "agent", "auth.json");
	const target = join(dir, ".prime-team", "agent", "auth.json");
	const main = JSON.stringify({
		example: { type: "api_key", key: "FAKE_UPSTREAM_SECRET" },
		anthropic: { type: "api_key", key: "FAKE_ANTHROPIC_UPSTREAM" },
		"mcp:remote-api": { type: "api_key", key: "FAKE_MCP_API" },
		"mcp:remote-oauth": {
			endpoint: "https://example.invalid/mcp",
			type: "oauth",
			access: "FAKE_MCP_ACCESS",
			refresh: "FAKE_MCP_REFRESH",
			expires: Date.now() + 3_600_000,
		},
		serper: { type: "api_key", key: "FAKE_SERPER" },
		"prime-agent-traces": { type: "api_key", key: "FAKE_TRACE_KEY" },
		oauth: {
			type: "oauth",
			access: "FAKE_OAUTH_SECRET",
			refresh: "FAKE_REFRESH_SECRET",
			expires: Date.now() + 3_600_000,
		},
		xai: { type: "oauth", access: "FAKE_XAI_SECRET", refresh: "FAKE_XAI_REFRESH", expires: Date.now() + 3_600_000 },
		expired: { type: "oauth", access: "FAKE_EXPIRED_SECRET", refresh: "FAKE_EXPIRED_REFRESH", expires: 1 },
		"prime-inference": { type: "api_key", key: "FAKE_PRIME_SECRET", primeTeam: { teamId: "team-id", name: "Team" } },
	});
	writeFileSync(source, main);
	writeFileSync(target, "{}");
	const script = `
        import assert from "node:assert/strict";
        import { readFileSync } from "node:fs";
        import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
        import { join } from "node:path";
        import { registerOAuthProvider } from "@earendil-works/pi-ai/oauth";
        import { AuthStorage } from "./src/core/auth-storage.ts";
        import { ModelRegistry } from "./src/core/model-registry.ts";
        import { OAuthSelectorComponent } from "./src/modes/interactive/components/oauth-selector.ts";
        import { initTheme } from "./src/modes/interactive/theme/theme.ts";
        import { oauthGrantUsable } from "./src/core/mcp/service-catalog.ts";
        let refreshCount = 0;
        for (const id of ["oauth", "expired", "xai"]) registerOAuthProvider({ id, name: id, login: async () => { throw Error("unused"); }, refreshToken: async () => { refreshCount++; throw Error("must not refresh"); }, getApiKey: (credential) => credential.access });
        const path = join(process.env.HOME, ".prime-team", "agent", "auth.json");
        const auth = AuthStorage.create();
        assert.equal(await AuthStorage.create(path).getApiKey("example"), "FAKE_UPSTREAM_SECRET");
        assert.equal(await auth.getApiKey("anthropic"), "FAKE_ENV_KEY");
        assert.equal(auth.getAuthStatus("anthropic").source, "environment");
        assert.equal((await auth.getApiKeyWithSourceToken("anthropic")).sourceToken.source, "environment");
        assert.equal(await auth.getApiKey("mcp:remote-api"), undefined);
        assert.equal(await auth.getApiKey("mcp:remote-oauth"), undefined);
        assert.equal(oauthGrantUsable(auth.get("mcp:remote-oauth"), "https://example.invalid/mcp").usable, false);
        assert.equal(await auth.getApiKey("serper"), undefined);
        assert.equal(await auth.getApiKey("prime-agent-traces"), undefined);
        auth.setFallbackResolver((provider) => provider === "custom" ? "FAKE_CUSTOM_KEY" : undefined);
        assert.equal(await auth.getApiKey("example"), "FAKE_UPSTREAM_SECRET");
        assert.equal(auth.getAuthStatus("example").source, "upstream");
        assert.match(auth.getAuthStatus("example").label, /read-only/);
        assert.equal(auth.getCurrentAuthSourceToken("example").source, "upstream");
        assert.equal(await auth.getApiKey("oauth"), "FAKE_OAUTH_SECRET");
        assert.equal(auth.getAuthStatus("oauth").credentialType, "oauth");
        initTheme("dark");
        const selector = new OAuthSelectorComponent("login", auth, [{ id: "oauth", name: "OAuth", authType: "oauth" }, { id: "example", name: "API", authType: "api_key" }, { id: "expired", name: "Expired", authType: "oauth" }], () => {}, () => {});
        const view = selector.render(120).join("\\n");
        assert.match(view, /upstream Prime Agent/);
        assert.match(view, /upstream OAuth expired/);
        const registry = ModelRegistry.inMemory(auth);
        const model = { id: "grok-4.5", name: "Grok", api: "openai-completions", provider: "xai", baseUrl: "https://api.x.ai/v1", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 1000 };
        assert.equal(registry.getModelForCurrentAuth(model).api, "openai-responses");
        const denied = await registry.getApiKeyAndHeaders({ ...model, headers: { Authorization: "SYNTHETIC_WRONG_HEADER" } });
        assert.equal(denied.ok, false);
        assert.doesNotMatch(JSON.stringify(denied), /SYNTHETIC_WRONG_HEADER/);
        assert.equal(await auth.getApiKey("expired"), undefined);
        assert.match(auth.getAuthStatus("expired").label, /expired/);
        assert.equal(refreshCount, 0);
        assert.equal(await auth.getApiKey("custom"), "FAKE_CUSTOM_KEY");
        assert.equal(auth.getProviderHeaders("prime-inference")["X-Prime-Team-ID"], "team-id");
        assert.equal(readFileSync(path, "utf8"), "{}");
        const writerScript = 'import { AuthStorage } from "./src/core/auth-storage.ts"; AuthStorage.create(process.argv[1]).set("example", { type: "api_key", key: "FAKE_TEAM_SECRET" });';
        const writer = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", writerScript, path], { encoding: "utf8" });
        assert.equal(writer.status, 0);
        assert.equal(await auth.getApiKey("example"), "FAKE_TEAM_SECRET");
        assert.equal(auth.getAuthStatus("example").source, "stored");
        auth.set("anthropic", { type: "api_key", key: "FAKE_LOCAL_ANTHROPIC" });
        assert.equal(await auth.getApiKey("anthropic"), "FAKE_LOCAL_ANTHROPIC");
        assert.equal(auth.getAuthStatus("anthropic").source, "stored");
        auth.set("mcp:remote-oauth", { type: "oauth", access: "FAKE_LOCAL_MCP_OAUTH", refresh: "FAKE_LOCAL_MCP_REFRESH", expires: Date.now() + 3600000, endpoint: "https://example.invalid/mcp" });
        assert.equal(oauthGrantUsable(auth.get("mcp:remote-oauth"), "https://example.invalid/mcp").usable, true);
        auth.set("mcp:remote-api", { type: "api_key", key: "FAKE_LOCAL_MCP" });
        assert.equal(await auth.getApiKey("mcp:remote-api"), "FAKE_LOCAL_MCP");
        auth.set("other", { type: "api_key", key: "FAKE_ANOTHER_TEAM_KEY" });
        assert.equal(await auth.getApiKey("other"), "FAKE_ANOTHER_TEAM_KEY");
        assert.equal(refreshCount, 0);
    `;
	const env = {
		...process.env,
		HOME: dir,
		USERPROFILE: dir,
		TMPDIR: dir,
		PI_OFFLINE: "1",
		PI_PACKAGE_DIR: "",
		PRIME_AGENT_TEAM_CODING_AGENT_DIR: "",
		PRIME_API_KEY: "",
		PRIME_TEAM_ID: "",
		XAI_API_KEY: "",
		ANTHROPIC_API_KEY: "FAKE_ENV_KEY",
	};
	const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
		cwd: process.cwd(),
		env,
		encoding: "utf8",
		timeout: 15000,
	});
	expect(result.status, `${result.stderr}`).toBe(0);
	expect(result.stdout + result.stderr).not.toMatch(/FAKE_(UPSTREAM|OAUTH|REFRESH|EXPIRED|PRIME|TEAM|ANOTHER)/);
	expect(readFileSync(source, "utf8")).toBe(main);
});

test("explicit Team directory and explicit auth path never use upstream", () => {
	const dir = home();
	writeFileSync(
		join(dir, ".prime", "agent", "auth.json"),
		JSON.stringify({ example: { type: "api_key", key: "FAKE_OVERRIDE_MAIN" } }),
	);
	const custom = join(dir, "custom");
	mkdirSync(custom);
	const script = `import assert from "node:assert/strict"; import { join } from "node:path"; import { AuthStorage } from "./src/core/auth-storage.ts"; const auth = AuthStorage.create(); assert.equal(await auth.getApiKey("example"), undefined); assert.equal(await AuthStorage.create(join(process.env.HOME, ".prime-team", "agent", "auth.json")).getApiKey("example"), undefined);`;
	const env = {
		...process.env,
		HOME: dir,
		USERPROFILE: dir,
		TMPDIR: dir,
		PI_OFFLINE: "1",
		PI_PACKAGE_DIR: "",
		PRIME_AGENT_TEAM_CODING_AGENT_DIR: custom,
	};
	const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
		cwd: process.cwd(),
		env,
		encoding: "utf8",
		timeout: 15000,
	});
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout + result.stderr).not.toContain("FAKE_OVERRIDE_MAIN");
});

test("unsafe or malformed upstream credentials fail without exposing contents", () => {
	const dir = home();
	const auth = join(dir, ".prime", "agent", "auth.json");
	writeFileSync(auth, "INVALID_FAKE_SECRET");
	expect(() => readUpstreamCredential(dir, "example")).toThrow(/cannot safely read/);
	try {
		readUpstreamCredential(dir, "example");
	} catch (error) {
		expect(String(error)).not.toContain("INVALID_FAKE_SECRET");
	}
	writeFileSync(auth, "{}");
	linkSync(auth, join(dir, "other-link"));
	expect(() => readUpstreamCredential(dir, "example")).toThrow(/cannot safely read/);
});

// test-policy: allow conditional-or-disabled-test -- Windows requires developer mode or elevation to create file symlinks; Linux CI runs this test.
test.skipIf(process.platform === "win32")("rejects a symlinked upstream auth file", () => {
	const dir = home();
	const original = join(dir, "target.json");
	writeFileSync(original, "{}");
	symlinkSync(original, join(dir, ".prime", "agent", "auth.json"));
	expect(() => readUpstreamCredential(dir, "example")).toThrow(/cannot safely read/);
});

test.each(["malformed", "oversize"])(
	"bad upstream %s does not block runtime, Team, environment or model fallback",
	(kind) => {
		const dir = home();
		const source = join(dir, ".prime", "agent", "auth.json");
		const target = join(dir, ".prime-team", "agent", "auth.json");
		writeFileSync(target, JSON.stringify({ local: { type: "api_key", key: "FAKE_LOCAL_OK" } }));
		writeFileSync(source, "PRIVATE_INVALID_MARKER");
		if (kind === "oversize") truncateSync(source, 8 * 1024 * 1024 + 1);
		const before = createHash("sha256").update(readFileSync(source)).digest("hex");
		const script = `
      import assert from "node:assert/strict";
      import { AuthStorage } from "./src/core/auth-storage.ts";
      import { ModelRegistry } from "./src/core/model-registry.ts";
      const auth = AuthStorage.create();
      auth.setRuntimeApiKey("runtime", "FAKE_RUNTIME_OK");
      assert.equal(await auth.getApiKey("runtime"), "FAKE_RUNTIME_OK");
      assert.equal(auth.getAuthStatus("runtime").source, "runtime");
      assert.equal(await auth.getApiKey("local"), "FAKE_LOCAL_OK");
      assert.equal(auth.getAuthStatus("local").source, "stored");
      assert.equal(await auth.getApiKey("anthropic"), "FAKE_ENV_OK");
      assert.equal(auth.getAuthStatus("anthropic").source, "environment");
      auth.setFallbackResolver((provider) => provider === "fallback" ? "FAKE_FALLBACK_OK" : undefined);
      assert.equal(await auth.getApiKey("fallback"), "FAKE_FALLBACK_OK");
      const registry = ModelRegistry.inMemory(auth);
      registry.registerProvider("models-provider", { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "FAKE_MODELS_KEY", models: [{ id: "sample", name: "sample", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 1000 }] });
      assert.equal(await registry.getApiKeyForProvider("models-provider"), "FAKE_MODELS_KEY");
      assert.equal(await auth.getApiKey("missing"), undefined);
      assert.match(auth.getAuthStatus("missing").label, /cannot safely read upstream/);
      assert.doesNotMatch(auth.getAuthStatus("missing").label, /PRIVATE_INVALID_MARKER/);
    `;
		const env = {
			...process.env,
			HOME: dir,
			USERPROFILE: dir,
			TMPDIR: dir,
			PI_OFFLINE: "1",
			PI_PACKAGE_DIR: "",
			PRIME_AGENT_TEAM_CODING_AGENT_DIR: "",
			ANTHROPIC_API_KEY: "FAKE_ENV_OK",
		};
		const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
			cwd: process.cwd(),
			env,
			encoding: "utf8",
			timeout: 15000,
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout + result.stderr).not.toContain("PRIVATE_INVALID_MARKER");
		expect(createHash("sha256").update(readFileSync(source)).digest("hex")).toBe(before);
	},
);

// test-policy: allow conditional-or-disabled-test -- the Team installer and its socket-based package test are not implemented for Windows; Linux CI runs this test.
test.skipIf(process.platform === "win32").each(["fresh", "existing"])(
	"installed Team RPC %s uses upstream provider without copying auth",
	(kind) => {
		const dir = home();
		const root = join(dir, "package");
		const entry = join(root, "dist", "bundle", "cli.js");
		const work = join(dir, "work");
		const socket = join(dir, "team.sock");
		mkdirSync(join(root, "dist", "bundle"), { recursive: true });
		mkdirSync(work);
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				name: "prime-agent-team",
				version: "0.9.8",
				type: "module",
				piConfig: { name: "prime-agent-team", configDir: ".prime-team/agent" },
			}),
		);
		symlinkSync(join(process.cwd(), "..", "..", "node_modules"), join(root, "node_modules"), "dir");
		cpSync(
			join(process.cwd(), "src", "modes", "interactive", "theme"),
			join(root, "dist", "modes", "interactive", "theme"),
			{ recursive: true },
		);
		buildSync({
			entryPoints: [join(process.cwd(), "src", "cli.ts")],
			outfile: entry,
			bundle: true,
			platform: "node",
			format: "esm",
			packages: "external",
			define: { __PI_BUNDLED__: "true", __PI_BUILD_ID__: '"team-rpc-test"' },
			logLevel: "silent",
		});
		const source = join(dir, ".prime", "agent", "auth.json");
		const teamDir = join(dir, ".prime-team", "agent");
		const sourceAuth = JSON.stringify({
			anthropic: { type: "api_key", key: "FAKE_RPC_PRIVATE_KEY" },
			"mcp:service": { type: "api_key", key: "FAKE_RPC_MCP_KEY" },
		});
		writeFileSync(source, sourceAuth);
		writeFileSync(
			join(dir, ".prime", "agent", "settings.json"),
			JSON.stringify({
				defaultProvider: "anthropic",
				defaultModel: "claude-fable-5",
				onboardingCompleted: true,
				telemetry: { enabled: false },
			}),
		);
		if (kind === "fresh") rmSync(teamDir, { recursive: true });
		else writeFileSync(join(teamDir, "auth.json"), "{}");
		const env = {
			PATH: process.env.PATH,
			HOME: dir,
			USERPROFILE: dir,
			TMPDIR: dir,
			XDG_CACHE_HOME: join(dir, "cache"),
			XDG_CONFIG_HOME: join(dir, "xdg"),
			PI_OFFLINE: "1",
			PRIME_AGENT_KERNEL_VENV: join(dir, "venv"),
		};
		try {
			const input = '{"id":"s","type":"get_state"}\n{"id":"m","type":"get_available_models"}\n';
			const rpc = spawnSync(
				process.execPath,
				[
					entry,
					"--mode",
					"rpc",
					"--no-session",
					"--offline",
					"--no-builtin-tools",
					"--no-extensions",
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
					"--no-context-files",
					"--cwd",
					work,
					"--daemon-socket",
					socket,
				],
				{ cwd: work, env, encoding: "utf8", input, timeout: 30000 },
			);
			expect(rpc.status, rpc.stderr).toBe(0);
			const lines = rpc.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(lines.find((row) => row.id === "s")).toMatchObject({
				success: true,
				data: { model: { provider: "anthropic", id: "claude-fable-5" } },
			});
			expect(lines.find((row) => row.id === "m").data.models).toContainEqual(
				expect.objectContaining({ provider: "anthropic", id: "claude-fable-5" }),
			);
			expect(rpc.stdout + rpc.stderr).not.toContain("FAKE_RPC_PRIVATE_KEY");
			expect(readFileSync(source, "utf8")).toBe(sourceAuth);
			expect(JSON.parse(readFileSync(join(teamDir, "auth.json"), "utf8"))).toEqual({});
			const logs = join(teamDir, "logs");
			if (existsSync(logs))
				for (const entry of readdirSync(logs, { recursive: true, withFileTypes: true })) {
					if (entry.isFile())
						expect(readFileSync(join(entry.parentPath, entry.name), "utf8")).not.toContain(
							"FAKE_RPC_PRIVATE_KEY",
						);
				}
		} finally {
			const shutdown = spawnSync(process.execPath, [entry, "shutdown", "--force"], {
				cwd: work,
				env,
				encoding: "utf8",
				timeout: 30000,
			});
			expect(shutdown.status, shutdown.stderr).toBe(0);
			expect(existsSync(socket)).toBe(false);
		}
	},
);

test("concurrent Team logout and another provider login preserve both changes", async () => {
	const dir = home();
	const source = join(dir, ".prime", "agent", "auth.json");
	const target = join(dir, ".prime-team", "agent", "auth.json");
	const main = JSON.stringify({ blocked: { type: "api_key", key: "FAKE_SOURCE_CONCURRENT" } });
	writeFileSync(source, main);
	writeFileSync(target, "{}");
	const script = `import { AuthStorage } from "./src/core/auth-storage.ts"; const auth = AuthStorage.create(); console.log("ready"); process.stdin.once("data", () => { if (process.argv[1] === "logout") auth.logout("blocked"); else auth.set("independent", { type: "api_key", key: "FAKE_CONCURRENT_TEAM" }); });`;
	const env = {
		...process.env,
		HOME: dir,
		USERPROFILE: dir,
		TMPDIR: dir,
		PI_OFFLINE: "1",
		PRIME_AGENT_TEAM_CODING_AGENT_DIR: "",
		PI_PACKAGE_DIR: "",
	};
	const children = ["logout", "login"].map((arg) =>
		spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, arg], {
			cwd: process.cwd(),
			env,
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
						if (!outputs[i].includes("ready")) reject(new Error(`early exit ${code}`));
					});
				}),
		);
		const done = children.map(
			(child) =>
				new Promise<number | null>((resolve, reject) => {
					child.once("error", reject);
					child.once("exit", resolve);
				}),
		);
		await Promise.all(ready);
		for (const child of children) child.stdin.end("go");
		expect(await Promise.all(done)).toEqual([0, 0]);
		const team = JSON.parse(readFileSync(target, "utf8"));
		expect(team.independent).toEqual({ type: "api_key", key: "FAKE_CONCURRENT_TEAM" });
		expect(team.__prime_agent_team_metadata_v1__.providers).toContain("blocked");
		expect(readFileSync(source, "utf8")).toBe(main);
		expect(outputs.join("")).not.toContain("FAKE_SOURCE_CONCURRENT");
	} finally {
		for (const child of children) child.kill();
	}
});
