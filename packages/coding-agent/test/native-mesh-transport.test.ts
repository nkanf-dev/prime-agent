import { readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configureNativeMeshDiagnostic } from "../src/modes/daemon/native-mesh/diagnostic.js";
import {
	NativeMeshRequestError,
	NativeMeshTransport,
	nativeMeshAgentId,
	nativeMeshRequestId,
} from "../src/modes/daemon/native-mesh/transport.js";

// Minimal protocol fixture; a separate integration test must exercise the real NAS route.
describe("native mesh transport seam", () => {
	const a = nativeMeshAgentId("host-a", "root");
	const b = nativeMeshAgentId("host-b", "root");
	const entries = new Map<string, Record<string, unknown>>();
	const messages = new Map<string, Record<string, unknown>>();
	let server: Server;
	let url: string;
	let aClient: NativeMeshTransport;
	let bClient: NativeMeshTransport;
	let corrupt = false;
	let failStore = false;
	beforeAll(async () => {
		server = createServer(async (req, res) => {
			if (req.headers.authorization !== "Bearer test-only") {
				res.writeHead(401).end();
				return;
			}
			let raw = "";
			for await (const part of req) raw += part;
			const path = new URL(req.url!, "http://localhost");
			let data: unknown;
			if (path.pathname === "/v1/native-mesh/agents" && req.method === "POST") {
				const body = JSON.parse(raw);
				const id = nativeMeshAgentId(body.hostId, body.agentId);
				const agent = { ...body, id, lastHeartbeatAt: new Date().toISOString(), status: "observed" };
				entries.set(id, agent);
				data = { agent };
			} else if (path.pathname === "/v1/native-mesh/agents") {
				data = { agents: [...entries.values()] };
			} else if (path.pathname === "/v1/messages" && req.method === "POST") {
				if (failStore) {
					res.writeHead(503).end();
					return;
				}
				const body = JSON.parse(raw),
					old = messages.get(body.requestId);
				if (old && (old.from !== body.from || old.to !== body.to || old.text !== body.text)) {
					res.writeHead(409).end();
					return;
				}
				const value = old ?? { ...body, createdAt: new Date().toISOString(), acknowledgedAt: null };
				messages.set(body.requestId, value);
				data = { status: "accepted", duplicate: !!old, message: corrupt ? { ...value, to: a } : value };
			} else if (path.pathname === "/v1/messages") {
				data = {
					messages: [...messages.values()].filter(
						(v) => v.to === path.searchParams.get("to") && !v.acknowledgedAt,
					),
				};
			} else {
				const match = path.pathname.match(/^\/v1\/messages\/([^/]+)\/ack$/);
				const found = match && messages.get(match[1]!);
				if (!found) {
					res.writeHead(404).end();
					return;
				}
				found.acknowledgedAt ??= new Date().toISOString();
				data = { status: "acknowledged", message: found };
			}
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		aClient = new NativeMeshTransport({ url, token: "test-only" });
		bClient = new NativeMeshTransport({ url, token: "test-only" });
	});
	beforeEach(() => {
		entries.clear();
		messages.clear();
		corrupt = false;
		failStore = false;
	});
	afterAll(async () => {
		await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
	});
	it("uses collision-resistant host qualified identities", () => {
		expect(a).not.toBe(b);
		expect(nativeMeshAgentId("ab", "c")).not.toBe(nativeMeshAgentId("a", "bc"));
		expect(nativeMeshRequestId(a, "1")).not.toBe(nativeMeshRequestId(b, "1"));
	});
	it("registers and observes without claiming online or authorization", async () => {
		await aClient.register({ hostId: "host-a", agentId: "root", parentId: null, name: "one", state: "active" });
		await bClient.register({ hostId: "host-b", agentId: "root", parentId: null, name: "two", state: "active" });
		expect((await aClient.discover()).map((x) => x.id)).toEqual([a, b]);
	});
	it("stores idempotently, exposes repeated pending until explicit ack", async () => {
		const input = { from: a, to: b, callerMessageId: "fixed", text: "hello" };
		const first = await aClient.store(input);
		expect(first.deliveryStatus).toBe("stored");
		expect(await aClient.store(input)).toEqual(first);
		expect((await bClient.pending(b)).length).toBe(1);
		expect((await bClient.pending(b)).length).toBe(1);
		await bClient.acknowledge(first.requestId);
		await bClient.acknowledge(first.requestId);
		expect(await bClient.pending(b)).toEqual([]);
		await expect(aClient.store({ ...input, text: "other" })).rejects.toMatchObject({
			outcome: "rejected",
			status: 409,
		});
	});
	it("does not fake storage when successful response mismatches", async () => {
		corrupt = true;
		await expect(aClient.store({ from: a, to: b, callerMessageId: "corrupt", text: "hello" })).rejects.toBeInstanceOf(
			NativeMeshRequestError,
		);
		corrupt = false;
	});
	it("reports uncertain failures without claiming storage", async () => {
		failStore = true;
		try {
			await expect(
				aClient.store({ from: a, to: b, callerMessageId: "unavailable", text: "hello" }),
			).rejects.toMatchObject({ outcome: "unknown", status: 503 });
		} finally {
			failStore = false;
		}
	});
	it("rejects non-loopback plaintext and excess UTF-8 payload", async () => {
		expect(() => new NativeMeshTransport({ url: "http://example.com", token: "x" })).toThrow();
		await expect(
			aClient.store({ from: a, to: b, callerMessageId: "big", text: "你".repeat(2731) }),
		).rejects.toThrow();
	});
});

describe("native mesh paginated discovery", () => {
	const agents = Array.from({ length: 7000 }, (_, i) => {
		const hostId = "host",
			agentId = `agent-${i}`;
		return {
			hostId,
			agentId,
			id: nativeMeshAgentId(hostId, agentId),
			parentId: null,
			name: "x".repeat(128),
			state: "active",
			status: "observed",
			lastHeartbeatAt: "2020-01-01T00:00:00.000Z",
		};
	}).sort((a, b) => a.id.localeCompare(b.id));
	let server: Server, client: NativeMeshTransport;
	let mode = "ok",
		calls = 0;
	const requests: URLSearchParams[] = [];
	const revisionValue = "847392658174";
	const tokenValue = "sensitive-token-never-log-829357";
	beforeAll(async () => {
		server = createServer((req, res) => {
			const query = new URL(req.url!, "http://localhost").searchParams;
			calls++;
			requests.push(new URLSearchParams(query));
			const cursor = query.get("after");
			const limit = Number(query.get("limit"));
			if (
				((mode === "old" || mode === "old-too-many" || mode === "old-later-400" || mode === "old-changed") &&
					limit > 100) ||
				mode === "both-400" ||
				((mode === "later-400" || mode === "old-later-400") && cursor)
			) {
				res.writeHead(400).end("private server metadata");
				return;
			}
			if (
				(((mode === "changed" && calls === 2) || (mode === "old-changed" && calls === 3)) && cursor) ||
				(mode === "always-changed" && cursor)
			) {
				res.writeHead(409).end();
				return;
			}
			if (mode === "slow") {
				// Leave the request pending until the client aborts at its deadline.
				req.on("close", () => res.destroy());
				return;
			}
			const start = cursor ? agents.findIndex((a) => a.id === cursor) + 1 : 0;
			let page = agents.slice(start, start + limit);
			let revision = revisionValue;
			let nextCursor: string | null = start + page.length < agents.length ? page.at(-1)!.id : null;
			if (mode === "duplicate") page = [page[0]!, page[0]!];
			if (mode === "unordered") page = page.slice().reverse();
			if (mode === "bad-record") page = [{ ...page[0]!, status: "online" } as (typeof page)[number]];
			if (mode === "bad-cursor") nextCursor = agents[500]!.id;
			if (mode === "bad-revision" && cursor) revision = "2";
			if (mode === "too-many" || mode === "old-too-many") page = agents.slice(0, limit + 1);
			if (mode === "cross-duplicate" && cursor) page = [agents[start - 1]!, ...page.slice(1)];
			const padding =
				mode === "byte-budget" ? " ".repeat(1_950_000) : mode === "page-budget" ? " ".repeat(2 * 1024 * 1024) : "";
			res.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({ version: 2, agents: page, nextCursor, revision }) + padding,
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		client = new NativeMeshTransport({
			url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
			token: tokenValue,
			timeoutMs: 30_000,
		});
	});
	beforeEach(() => {
		mode = "ok";
		calls = 0;
		requests.length = 0;
	});
	afterAll(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	it("reads more than 2 MiB in bounded pages without losing observations", async () => {
		mode = "ok";
		calls = 0;
		expect(Buffer.byteLength(JSON.stringify({ agents }))).toBeGreaterThan(2 * 1024 * 1024);
		expect(await client.discover()).toEqual(agents);
		expect(calls).toBe(7);
		expect(requests.map((query) => query.get("limit"))).toEqual(Array(7).fill("1000"));
		expect([...requests[0]!.keys()]).toEqual(["limit"]);
		for (let i = 1; i < requests.length; i++) {
			expect(Object.fromEntries(requests[i]!)).toEqual({
				limit: "1000",
				after: agents[i * 1000 - 1]!.id,
				revision: revisionValue,
			});
		}
	});
	it("falls back once from a first-page 400 and reads the complete old-server scan", async () => {
		mode = "old";
		expect(await client.discover()).toEqual(agents);
		expect(calls).toBe(71);
		expect(Object.fromEntries(requests[0]!)).toEqual({ limit: "1000" });
		expect(Object.fromEntries(requests[1]!)).toEqual({ limit: "100" });
		for (let i = 2; i < requests.length; i++) {
			expect(Object.fromEntries(requests[i]!)).toEqual({
				limit: "100",
				after: agents[(i - 1) * 100 - 1]!.id,
				revision: revisionValue,
			});
		}
	});
	it("does not fall back after a later page returns 400", async () => {
		mode = "later-400";
		await expect(client.discover()).rejects.toMatchObject({
			operation: "discover",
			outcome: "rejected",
			status: 400,
		});
		expect(calls).toBe(2);
		expect(requests.map((query) => query.get("limit"))).toEqual(["1000", "1000"]);
	});
	it("does not fall back repeatedly if the old limit also returns 400", async () => {
		mode = "both-400";
		await expect(client.discover()).rejects.toMatchObject({
			operation: "discover",
			outcome: "rejected",
			status: 400,
		});
		expect(requests.map((query) => query.get("limit"))).toEqual(["1000", "100"]);
	});
	it("enforces the old page limit after fallback", async () => {
		mode = "old-too-many";
		await expect(client.discover()).rejects.toBeInstanceOf(NativeMeshRequestError);
		expect(requests.map((query) => query.get("limit"))).toEqual(["1000", "100"]);
	});
	it("does not retry a later-page 400 after falling back", async () => {
		mode = "old-later-400";
		await expect(client.discover()).rejects.toMatchObject({ status: 400 });
		expect(requests.map((query) => query.get("limit"))).toEqual(["1000", "100", "100"]);
	});
	it("retains the old limit when a 409 restarts a fallback scan", async () => {
		mode = "old-changed";
		expect(await client.discover()).toEqual(agents);
		expect(calls).toBe(73);
		expect(requests[3]!.get("after")).toBeNull();
		expect(requests[3]!.get("revision")).toBeNull();
		expect(requests.slice(1).every((query) => query.get("limit") === "100")).toBe(true);
	});
	it("does not expose request values or response metadata in diagnostics", async () => {
		const diagnostic = configureNativeMeshDiagnostic({ enabled: true, ttlMs: 30_000 });
		const path = await diagnostic.ready;
		expect(path).toBeDefined();
		try {
			mode = "later-400";
			await expect(client.discover()).rejects.toMatchObject({ status: 400 });
			await diagnostic.close();
			const output = await readFile(path!, "utf8");
			expect(output).toContain('"operation":"discover"');
			for (const value of [
				agents[999]!.id,
				revisionValue,
				"private server metadata",
				tokenValue,
				"after=",
				"revision=",
			]) {
				expect(output).not.toContain(value);
			}
		} finally {
			await diagnostic.close();
			configureNativeMeshDiagnostic();
			if (path) await rm(dirname(path), { recursive: true, force: true });
		}
	});
	it("restarts a changed scan rather than returning an inconsistent directory", async () => {
		mode = "changed";
		calls = 0;
		expect(await client.discover()).toEqual(agents);
		expect(calls).toBe(9);
		expect(requests[2]!.get("after")).toBeNull();
		expect(requests[2]!.get("revision")).toBeNull();
	});
	it("bounds retries, total bytes and the overall discovery deadline", async () => {
		mode = "always-changed";
		calls = 0;
		await expect(client.discover()).rejects.toMatchObject({ status: 409 });
		expect(calls).toBe(6);
		mode = "page-budget";
		calls = 0;
		await expect(client.discover()).rejects.toBeInstanceOf(NativeMeshRequestError);
		expect(calls).toBe(1);
		mode = "byte-budget";
		calls = 0;
		await expect(client.discover()).rejects.toBeInstanceOf(NativeMeshRequestError);
		expect(calls).toBeLessThan(20);
		mode = "slow";
		calls = 0;
		const quick = new NativeMeshTransport({
			url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
			token: "test",
			timeoutMs: 30,
		});
		await expect(quick.discover()).rejects.toBeInstanceOf(NativeMeshRequestError);
	});
	for (const kind of [
		"duplicate",
		"cross-duplicate",
		"unordered",
		"bad-record",
		"bad-cursor",
		"bad-revision",
		"too-many",
	]) {
		it(`rejects ${kind} pages instead of returning a partial directory`, async () => {
			mode = kind;
			calls = 0;
			await expect(client.discover()).rejects.toBeInstanceOf(NativeMeshRequestError);
		});
	}
});

describe("native mesh discovery time budgets", () => {
	const agents = Array.from({ length: 11 }, (_, i) => ({
		hostId: "host",
		agentId: `agent-${i}`,
		id: nativeMeshAgentId("host", `agent-${i}`),
		parentId: null,
		name: "agent",
		state: "active" as const,
		status: "observed" as const,
		lastHeartbeatAt: "2020-01-01T00:00:00.000Z",
	})).sort((a, b) => a.id.localeCompare(b.id));

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
		// Node's AbortSignal.timeout uses internal timers that fake timers do not
		// control. Replace only its clock, while preserving abort behavior.
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), ms);
			return controller.signal;
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	function pages(count: number, delayMs: number) {
		return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
			const cursor = new URL(String(input)).searchParams.get("after");
			const index = cursor ? agents.findIndex((agent) => agent.id === cursor) + 1 : 0;
			return new Promise<Response>((resolve, reject) => {
				const timer = setTimeout(() => {
					const agent = agents[index]!;
					resolve(
						new Response(
							JSON.stringify({
								version: 2,
								agents: [agent],
								nextCursor: index + 1 < count ? agent.id : null,
								revision: "1",
							}),
						),
					);
				}, delayMs);
				init?.signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			});
		});
	}

	it("allows the default discovery scan to exceed 10 seconds across bounded pages", async () => {
		const fetchMock = pages(2, 6_000);
		const client = new NativeMeshTransport({ url: "http://localhost", token: "test" });
		const result = client.discover();
		await vi.advanceTimersByTimeAsync(12_000);
		expect(await result).toEqual(agents.slice(0, 2));
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retains an explicit timeoutMs as the total discovery budget", async () => {
		const fetchMock = pages(2, 6_000);
		const client = new NativeMeshTransport({ url: "http://localhost", token: "test", timeoutMs: 10_000 });
		const rejection = expect(client.discover()).rejects.toMatchObject({ operation: "discover", outcome: "unknown" });
		await vi.advanceTimersByTimeAsync(10_000);
		await rejection;
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("gives discoveryTimeoutMs priority over timeoutMs in both directions", async () => {
		const fetchMock = pages(2, 6_000);
		const longer = new NativeMeshTransport({
			url: "http://localhost",
			token: "test",
			timeoutMs: 10_000,
			discoveryTimeoutMs: 15_000,
		});
		const result = longer.discover();
		await vi.advanceTimersByTimeAsync(12_000);
		expect(await result).toEqual(agents.slice(0, 2));
		expect(fetchMock).toHaveBeenCalledTimes(2);

		fetchMock.mockClear();
		const shorter = new NativeMeshTransport({
			url: "http://localhost",
			token: "test",
			timeoutMs: 20_000,
			discoveryTimeoutMs: 9_000,
		});
		const rejection = expect(shorter.discover()).rejects.toMatchObject({ operation: "discover", outcome: "unknown" });
		await vi.advanceTimersByTimeAsync(9_000);
		await rejection;
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("bounds the default total scan at 60 seconds", async () => {
		const fetchMock = pages(11, 6_000);
		const client = new NativeMeshTransport({ url: "http://localhost", token: "test" });
		const rejection = expect(client.discover()).rejects.toMatchObject({ operation: "discover", outcome: "unknown" });
		await vi.advanceTimersByTimeAsync(60_000);
		await rejection;
		expect(fetchMock).toHaveBeenCalledTimes(10);
	});

	it("still aborts a single default page request at 10 seconds", async () => {
		const fetchMock = pages(1, 20_000);
		const client = new NativeMeshTransport({ url: "http://localhost", token: "test" });
		const rejection = expect(client.discover()).rejects.toMatchObject({ operation: "discover", outcome: "unknown" });
		await vi.advanceTimersByTimeAsync(9_999);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await rejection;
	});
});
