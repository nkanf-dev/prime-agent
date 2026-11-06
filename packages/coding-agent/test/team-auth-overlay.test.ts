import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
        import { spawnSync } from "node:child_process";
        import { join } from "node:path";
        import { registerOAuthProvider } from "@earendil-works/pi-ai/oauth";
        import { AuthStorage } from "./src/core/auth-storage.ts";
        import { ModelRegistry } from "./src/core/model-registry.ts";
        import { OAuthSelectorComponent } from "./src/modes/interactive/components/oauth-selector.ts";
        import { initTheme } from "./src/modes/interactive/theme/theme.ts";
        let refreshCount = 0;
        for (const id of ["oauth", "expired", "xai"]) registerOAuthProvider({ id, name: id, login: async () => { throw Error("unused"); }, refreshToken: async () => { refreshCount++; throw Error("must not refresh"); }, getApiKey: (credential) => credential.access });
        const path = join(process.env.HOME, ".prime-team", "agent", "auth.json");
        const auth = AuthStorage.create();
        assert.equal(await AuthStorage.create(path).getApiKey("example"), undefined);
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
