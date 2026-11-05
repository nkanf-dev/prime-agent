import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../packages/coding-agent/examples/extensions/envinhands-heartbeat";

const keys = ["ENVINHANDS_URL", "ENVINHANDS_TOKEN", "ENVINHANDS_AGENT_ID", "ENVINHANDS_MACHINE_ID", "ENVINHANDS_ALLOW_INSECURE_HTTP"] as const;
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
beforeEach(() => { delete process.env.ENVINHANDS_ALLOW_INSECURE_HTTP; });
afterEach(() => { for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });

function load() {
	const hooks = new Map<string, () => void>();
	extension({ on: (name: string, fn: () => void) => hooks.set(name, fn) } as unknown as ExtensionAPI);
	return hooks;
}

test("disabled without explicit configuration and unsafe URL", () => {
	for (const key of keys) delete process.env[key];
	expect(load().size).toBe(0);
	process.env.ENVINHANDS_URL = "http://example.com";
	process.env.ENVINHANDS_TOKEN = "secret";
	process.env.ENVINHANDS_AGENT_ID = "agent-1";
	process.env.ENVINHANDS_MACHINE_ID = "machine-1";
	expect(load().size).toBe(0);
});

test.each([204, 503])("lifecycle sends only fixed fields to loopback and does not block on status %s", async (status) => {
	const received: { path: string; auth: string | null; body: unknown }[] = [];
	let complete!: () => void;
	const allReceived = new Promise<void>((resolve) => { complete = resolve; });
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
		received.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body: await req.json() });
		if (received.length === 4) complete();
		return new Response(null, { status });
	} });
	try {
		process.env.ENVINHANDS_URL = `http://127.0.0.1:${server.port}`;
		process.env.ENVINHANDS_TOKEN = "test-secret";
		process.env.ENVINHANDS_AGENT_ID = "agent-1";
		process.env.ENVINHANDS_MACHINE_ID = "machine-1";
		const hooks = load();
		for (const name of ["session_start", "agent_start", "agent_end", "session_shutdown"]) expect(hooks.get(name)?.()).toBeUndefined();
		await allReceived;
		expect(received).toHaveLength(4);
		expect(received.every((r) => r.path === "/v1/agents/heartbeat" && r.auth === "Bearer test-secret")).toBe(true);
		expect(received.map((r) => r.body)).toEqual(expect.arrayContaining(["session_start", "agent_start", "agent_end", "session_shutdown"].map((task) => ({ agentId: "agent-1", machineId: "machine-1", task }))));
	} finally { server.stop(true); }
});

test("non-loopback HTTP requires the exact opt-in and still rejects unsafe URLs", () => {
	process.env.ENVINHANDS_TOKEN = "test-secret";
	process.env.ENVINHANDS_AGENT_ID = "agent-1";
	process.env.ENVINHANDS_MACHINE_ID = "machine-1";
	process.env.ENVINHANDS_URL = "http://192.0.2.1:1234";
	for (const value of [undefined, "", "0", "true", "yes", " 1", "1 "]) {
		if (value === undefined) delete process.env.ENVINHANDS_ALLOW_INSECURE_HTTP;
		else process.env.ENVINHANDS_ALLOW_INSECURE_HTTP = value;
		expect(load().size).toBe(0);
	}
	delete process.env.ENVINHANDS_ALLOW_INSECURE_HTTP;
	for (const url of ["https://192.0.2.1", "http://127.0.0.1:1234"]) {
		process.env.ENVINHANDS_URL = url;
		expect(load().size).toBe(4);
	}
	process.env.ENVINHANDS_URL = "http://192.0.2.1:1234";
	process.env.ENVINHANDS_ALLOW_INSECURE_HTTP = "1";
	expect(load().size).toBe(4);
	delete process.env.ENVINHANDS_TOKEN;
	expect(load().size).toBe(0);
	process.env.ENVINHANDS_TOKEN = "test-secret";
	process.env.ENVINHANDS_MACHINE_ID = "bad/id";
	expect(load().size).toBe(0);
	process.env.ENVINHANDS_MACHINE_ID = "machine-1";
	for (const url of ["ftp://192.0.2.1/", "file:///tmp/socket", "http://u:p@192.0.2.1/", "http://192.0.2.1/path", "http://192.0.2.1/?q=x", "http://192.0.2.1/#x"]) {
		process.env.ENVINHANDS_URL = url;
		expect(load().size).toBe(0);
	}
});

test("opted-in non-loopback heartbeat keeps redirect protection", async () => {
	const requests: { path: string; auth: string | null }[] = [];
	let leaked = false;
	const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { leaked = true; return new Response(null, { status: 204 }); } });
	const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
		requests.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization") });
		return Response.redirect(`http://127.0.0.1:${target.port}/`, 302);
	} });
	const originalFetch = globalThis.fetch;
	const attempts: Promise<unknown>[] = [];
	const urls: string[] = [];
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		urls.push(url.href);
		// Route the documentation-only address to a local server; never contact the network address.
		const attempt = originalFetch(`http://127.0.0.1:${source.port}${url.pathname}`, init);
		attempts.push(attempt.catch(() => {}));
		return attempt;
	}) as typeof fetch;
	try {
		process.env.ENVINHANDS_URL = "http://192.0.2.1:1234";
		process.env.ENVINHANDS_TOKEN = "test-secret";
		process.env.ENVINHANDS_AGENT_ID = "agent-1";
		process.env.ENVINHANDS_MACHINE_ID = "machine-1";
		process.env.ENVINHANDS_ALLOW_INSECURE_HTTP = "1";
		const hooks = load();
		expect(hooks.size).toBe(4);
		hooks.get("session_start")!();
		hooks.get("session_shutdown")!();
		await Promise.all(attempts);
		expect(urls).toEqual(["http://192.0.2.1:1234/v1/agents/heartbeat", "http://192.0.2.1:1234/v1/agents/heartbeat"]);
		expect(requests).toHaveLength(2);
		expect(requests.every((r) => r.path === "/v1/agents/heartbeat" && r.auth === "Bearer test-secret")).toBe(true);
		expect(leaked).toBe(false);
	} finally { globalThis.fetch = originalFetch; source.stop(true); target.stop(true); }
});
