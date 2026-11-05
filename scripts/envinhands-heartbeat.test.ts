import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../packages/coding-agent/examples/extensions/envinhands-heartbeat";

const keys = ["ENVINHANDS_URL", "ENVINHANDS_TOKEN", "ENVINHANDS_AGENT_ID", "ENVINHANDS_MACHINE_ID"] as const;
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
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

test("lifecycle sends only fixed fields to loopback and does not block", async () => {
	const received: { path: string; auth: string | null; body: unknown }[] = [];
	let complete!: () => void;
	const allReceived = new Promise<void>((resolve) => { complete = resolve; });
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
		received.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body: await req.json() });
		if (received.length === 4) complete();
		return new Response(null, { status: 204 });
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
