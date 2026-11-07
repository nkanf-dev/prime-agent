import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { nativeMeshDiagnostic } from "../src/modes/daemon/native-mesh/diagnostic.js";
import { NativeMeshEndpoints } from "../src/modes/daemon/native-mesh/endpoints.js";
import { NativeMeshOperations } from "../src/modes/daemon/native-mesh/operations.js";
import { NativeMeshOutbox } from "../src/modes/daemon/native-mesh/outbox.js";
import { nativeMeshAgentId, nativeMeshRequestId } from "../src/modes/daemon/native-mesh/transport.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const agents = new Map<string, any>();
	const messages = new Map<string, any>();
	const transport = {
		register: vi.fn(async (registration: any) => {
			const entry = {
				...registration,
				id: nativeMeshAgentId(registration.hostId, registration.agentId),
				status: "observed",
				lastHeartbeatAt: new Date().toISOString(),
			};
			agents.set(entry.id, entry);
			return entry;
		}),
		discover: vi.fn(async () => [...agents.values()]),
		pending: vi.fn(async (to: string) => [...messages.values()].filter((m) => m.to === to && !m.acknowledgedAt)),
		store: vi.fn(async (item: any) => {
			const requestId = nativeMeshRequestId(item.from, item.callerMessageId);
			if (!messages.has(requestId))
				messages.set(requestId, {
					requestId,
					from: item.from,
					to: item.to,
					text: item.text,
					createdAt: new Date().toISOString(),
					acknowledgedAt: null,
				});
			return { requestId, deliveryStatus: "stored" as const };
		}),
		acknowledge: vi.fn(async (id: string) => {
			messages.get(id).acknowledgedAt = new Date().toISOString();
		}),
	};
	function supervisor(host: string, session: string) {
		const directory = mkdtempSync(join(tmpdir(), "mesh-supervisor-"));
		dirs.push(directory);
		const summary = {
			id: `active-${session}`,
			activeSessionId: `active-${session}`,
			sessionId: session,
			sessionName: session,
			sessionFile: `/tmp/${session}.jsonl`,
			rlmDepth: 0,
		};
		const recipient = { requestWorker: vi.fn(async (_command: any) => ({ success: true })) };
		const worker = { client: recipient, nativeMeshDeliveryCapable: true };
		const id = nativeMeshAgentId(host, session);
		const endpoint = { id, parentId: null, summary, worker };
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			nativeMeshConfig: { machineId: host, url: "http://127.0.0.1", token: "test" },
			nativeMesh: transport,
			nativeEndpoints: new NativeMeshEndpoints(join(directory, "endpoints")),
			catalog: { list: vi.fn(async () => []) },
			rlmSpawnLedger: () => ({ liveEdges: vi.fn(async () => []) }),
			defaultSessionConfig: {},
			workers: new Map(),
			roster: () => ({ values: () => [], byActiveSessionId: () => undefined }),
			nativeOperations: new NativeMeshOperations(join(directory, "operations")),
			nativeObservations: new Map(),
			nativeAttempts: new Map(),
			nativeOutboxSends: new Set(),
			nativeLocalEndpoints: () => [endpoint],
			clearRosterStaleness: vi.fn(),
			log: vi.fn(),
			shuttingDown: false,
		}) as any;
		supervisor.nativeOutbox = new NativeMeshOutbox(join(directory, "outbox"), transport, (requestId) =>
			supervisor.nativeOperations.markStored(requestId),
		);
		return { supervisor, summary, worker, recipient, id, directory };
	}
	return { transport, agents, messages, a: supervisor("host-a", "one"), b: supervisor("host-b", "two") };
}
// Exercise the real local-endpoint selection: this session exists on disk but
// has no resident worker until pending mail wakes it.
function makePassive(b: ReturnType<typeof setup>["b"], wokeSessionId = "two") {
	const path = join(b.directory, "two.jsonl");
	writeFileSync(
		path,
		`${JSON.stringify({ type: "session", version: 3, id: "two", timestamp: new Date().toISOString(), cwd: b.directory })}\n`,
	);
	const info = {
		id: "two",
		path,
		cwd: b.directory,
		name: "two",
		rlmDepth: 0,
		created: new Date(),
		modified: new Date(),
		messageCount: 0,
		firstMessage: "",
		allMessagesText: "",
	};
	b.supervisor.nativeEndpoints.upsert({
		machineId: "host-b",
		sessionId: "two",
		sessionPath: path,
		rootPath: path,
		rootSessionId: "two",
		ancestors: [],
		name: "two",
		cwd: b.directory,
		rlmDepth: 0,
	});
	const summary = { ...b.summary, sessionId: wokeSessionId, sessionFile: path };
	Object.assign(b.worker, { descriptor: { lifecycle: "ready", rootActiveSessionId: summary.activeSessionId } });
	delete b.supervisor.nativeLocalEndpoints;
	Object.assign(b.supervisor, {
		catalog: { list: vi.fn(async () => [info]) },
		rlmSpawnLedger: () => ({ liveEdges: vi.fn(async () => []) }),
		workers: new Map(),
		roster: () => ({ values: () => [], byActiveSessionId: () => undefined }),
		findWorkerBySessionFile: vi.fn(() => b.worker),
		findSummaryInWorker: vi.fn(() => summary),
		createOrReuseWorker: vi.fn(async () => b.worker),
	});
	return { path, info, summary };
}
// A live root with no pre-existing registry binding. Exercise the real roster
// selection and registration path, then reopen the registry from disk.
function makeActiveRoot(b: ReturnType<typeof setup>["b"]) {
	const path = join(b.directory, "two.jsonl");
	writeFileSync(
		path,
		`${JSON.stringify({ type: "session", version: 3, id: "two", timestamp: new Date().toISOString(), cwd: b.directory })}\n`,
	);
	Object.assign(b.summary, { sessionFile: path, cwd: b.directory });
	Object.assign(b.worker, {
		descriptor: { workerId: "root-worker", lifecycle: "ready", rootActiveSessionId: b.summary.activeSessionId },
	});
	delete b.supervisor.nativeLocalEndpoints;
	b.supervisor.workers = new Map([["root-worker", b.worker]]);
	b.supervisor.roster = () => ({
		values: () => [{ workerId: "root-worker", summary: b.summary }],
		byActiveSessionId: () => undefined,
	});
	return { path, registryDir: join(b.directory, "endpoints") };
}
function addPassiveChild(b: ReturnType<typeof setup>["b"], rootPath: string) {
	const childPath = join(b.directory, "child.jsonl");
	writeFileSync(
		childPath,
		`${JSON.stringify({ type: "session", version: 3, id: "child", timestamp: new Date().toISOString(), cwd: b.directory, parentSession: rootPath, rlmDepth: 1 })}\n`,
	);
	b.supervisor.nativeEndpoints.upsert({
		machineId: "host-b",
		sessionId: "child",
		sessionPath: childPath,
		rootPath,
		rootSessionId: "two",
		ancestors: [{ sessionId: "two", sessionPath: rootPath }],
		name: "child",
		cwd: b.directory,
		rlmDepth: 1,
	});
	b.supervisor.rlmSpawnLedger = () => ({
		liveEdges: async () => [{ childId: "child", parent: rootPath, child: childPath, depth: 1, name: "child" }],
	});
	return { childPath, childId: nativeMeshAgentId("host-b", "child") };
}
function frame(supervisor: any, worker: any, source: any, type: string, requestId: string, attemptToken: string) {
	supervisor.handleWorkerFrame(
		worker,
		{
			header: { kind: "outbound", outboundType: type },
			payload: Buffer.from(JSON.stringify({ type, requestId, attemptToken })),
		},
		source,
	);
}
async function settle() {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("supervisor native mesh handoff", () => {
	it("registers stable identities and returns stored, then acknowledges only matching persisted frame", async () => {
		const { transport, messages, a, b } = setup();
		await a.supervisor.sweepNativeMesh();
		await b.supervisor.sweepNativeMesh();
		await a.supervisor.sweepNativeMesh();
		expect(a.supervisor.nativeMeshPeers()).toMatchObject([{ activeSessionId: b.id, sessionName: "host-b/two" }]);
		const reply = await a.supervisor.sendNativeMeshMessage(
			{
				type: "send_message",
				id: "call",
				targetActiveSessionId: b.id,
				fromActiveSessionId: a.summary.activeSessionId,
				message: "hello",
			},
			a.summary,
		);
		expect(reply.data.deliveryStatus).toBe("stored");
		expect(reply.data.deliveredAt).toBeUndefined();
		expect(messages.size).toBe(1);
		await b.supervisor.sweepNativeMesh();
		const delivery = b.recipient.requestWorker.mock.calls[0]![0] as any;
		expect(delivery).toMatchObject({
			type: "worker_native_mesh_deliver_message",
			expectedSessionId: "two",
			message: "hello",
		});
		expect(transport.acknowledge).not.toHaveBeenCalled();
		frame(b.supervisor, b.worker, b.recipient, "native_mesh_message_persisted", delivery.requestId, "wrong-token");
		frame(
			b.supervisor,
			b.worker,
			{ requestWorker: vi.fn() },
			"native_mesh_message_persisted",
			delivery.requestId,
			delivery.attemptToken,
		);
		expect(transport.acknowledge).not.toHaveBeenCalled();
		frame(
			b.supervisor,
			b.worker,
			b.recipient,
			"native_mesh_message_persisted",
			delivery.requestId,
			delivery.attemptToken,
		);
		await settle();
		expect(transport.acknowledge).toHaveBeenCalledOnce();
		expect(messages.get(delivery.requestId).acknowledgedAt).toBeTruthy();
	});
	it("retries a disconnected worker and ignores the old connection and dropped attempts", async () => {
		const { transport, a, b } = setup();
		await a.supervisor.sweepNativeMesh();
		await b.supervisor.sweepNativeMesh();
		await a.supervisor.sweepNativeMesh();
		await a.supervisor.sendNativeMeshMessage(
			{ type: "send_message", targetActiveSessionId: b.id, message: "retry" },
			a.summary,
		);
		await b.supervisor.sweepNativeMesh();
		const first = b.recipient.requestWorker.mock.calls[0]![0] as any;
		const replacement = { requestWorker: vi.fn(async (_command: any) => ({ success: true })) };
		b.worker.client = replacement;
		await b.supervisor.sweepNativeMesh();
		const second = replacement.requestWorker.mock.calls[0]![0] as any;
		expect(second.requestId).toBe(first.requestId);
		expect(second.attemptToken).not.toBe(first.attemptToken);
		frame(b.supervisor, b.worker, b.recipient, "native_mesh_message_persisted", first.requestId, first.attemptToken);
		frame(b.supervisor, b.worker, replacement, "native_mesh_message_dropped", second.requestId, second.attemptToken);
		expect(transport.acknowledge).not.toHaveBeenCalled();
		await b.supervisor.sweepNativeMesh();
		const third = replacement.requestWorker.mock.calls[1]![0] as any;
		frame(b.supervisor, b.worker, replacement, "native_mesh_message_persisted", third.requestId, third.attemptToken);
		await settle();
		expect(transport.acknowledge).toHaveBeenCalledOnce();
	});
	it("recovers a crash after durable binding and before outbox enqueue", async () => {
		const { transport, messages, a, b } = setup();
		await a.supervisor.sweepNativeMesh();
		await b.supervisor.sweepNativeMesh();
		await a.supervisor.sweepNativeMesh();
		const input = { from: a.id, to: b.id, text: "bind crash", operationId: "bind-before-enqueue" };
		const id = a.supervisor.nativeOperations.bind(input);
		expect(a.supervisor.nativeOutbox.pending()).toEqual([]);
		// Simulate process restart at the exact boundary, with no enqueue or broker call.
		a.supervisor.nativeOperations = new NativeMeshOperations(join(a.directory, "operations"));
		a.supervisor.nativeOutbox = new NativeMeshOutbox(join(a.directory, "outbox"), transport, (requestId: string) =>
			a.supervisor.nativeOperations.markStored(requestId),
		);
		await a.supervisor.sweepNativeMesh();
		await settle();
		expect(messages.size).toBe(1);
		expect(messages.has(id)).toBe(true);
		expect(a.supervisor.nativeOperations.pending()).toEqual([]);
		expect(a.supervisor.nativeOutbox.pending()).toEqual([]);
		await a.supervisor.sweepNativeMesh();
		await settle();
		expect(messages.size).toBe(1);
	});
	it("retries the complete call with the same operation after a lost broker response and restart", async () => {
		const { transport, messages, a, b } = setup();
		await a.supervisor.sweepNativeMesh();
		await b.supervisor.sweepNativeMesh();
		await a.supervisor.sweepNativeMesh();
		const real = transport.store.getMockImplementation()!;
		transport.store.mockImplementationOnce(async (item: any) => {
			await real(item);
			throw new Error("lost response");
		});
		const command = {
			type: "send_message",
			targetActiveSessionId: b.id,
			message: "uncertain",
			nativeMeshOperationId: "op-stable",
		};
		await expect(a.supervisor.sendNativeMeshMessage(command, a.summary)).rejects.toThrow(
			/outcome is unknown .*operation_id "op-stable"/,
		);
		const pending = a.supervisor.nativeOutbox.pending();
		expect(pending).toHaveLength(1);
		a.supervisor.nativeOperations = new NativeMeshOperations(join(a.directory, "operations"));
		a.supervisor.nativeOutbox = new NativeMeshOutbox(join(a.directory, "outbox"), transport, (requestId: string) =>
			a.supervisor.nativeOperations.markStored(requestId),
		);
		const retry = await a.supervisor.sendNativeMeshMessage(command, a.summary);
		expect(retry.data).toMatchObject({ id: pending[0], operationId: "op-stable", deliveryStatus: "stored" });
		expect(a.supervisor.nativeOutbox.pending()).toEqual([]);
		expect(messages.size).toBe(1);
		expect([...messages.keys()]).toEqual(pending);
		// A later retry after the outbox is gone is still the same broker request.
		const again = await a.supervisor.sendNativeMeshMessage(command, a.summary);
		expect(again.data.id).toBe(pending[0]);
		expect(messages.size).toBe(1);
		await expect(a.supervisor.sendNativeMeshMessage({ ...command, message: "different" }, a.summary)).rejects.toThrow(
			"Conflicting native mesh operation",
		);
		await expect(
			a.supervisor.sendNativeMeshMessage({ ...command, targetActiveSessionId: a.id }, a.summary),
		).rejects.toThrow("Conflicting native mesh operation");
		// A new operation is intentionally distinct, even for identical text.
		await a.supervisor.sendNativeMeshMessage({ ...command, nativeMeshOperationId: "op-distinct" }, a.summary);
		expect(messages.size).toBe(2);
	});
});

describe("supervisor native mesh inactive delivery", () => {
	it("persists a successfully registered live root and polls it after restart as inactive", async () => {
		const { transport, b } = setup();
		const root = makeActiveRoot(b);
		expect(b.supervisor.nativeEndpoints.read("host-b", "two")).toBeUndefined();
		await b.supervisor.sweepNativeMesh();
		expect(transport.register).toHaveBeenCalledWith(
			expect.objectContaining({
				hostId: "host-b",
				agentId: "two",
				state: "active",
				parentId: null,
			}),
		);
		const reopened = new NativeMeshEndpoints(root.registryDir);
		expect(reopened.read("host-b", "two")).toMatchObject({
			machineId: "host-b",
			sessionId: "two",
			sessionPath: root.path,
			rootPath: root.path,
			rootSessionId: "two",
			ancestors: [],
			cwd: b.directory,
		});
		// Simulate a restarted supervisor with no live workers, preserving only the
		// durable registry. Do not seed the passive fixture or manually register it.
		b.supervisor.nativeEndpoints = reopened;
		b.supervisor.workers = new Map();
		b.supervisor.roster = () => ({ values: () => [], byActiveSessionId: () => undefined });
		transport.register.mockClear();
		transport.pending.mockClear();
		await b.supervisor.sweepNativeMesh();
		expect(transport.register).toHaveBeenCalledWith(
			expect.objectContaining({
				hostId: "host-b",
				agentId: "two",
				state: "inactive",
				parentId: null,
			}),
		);
		expect(transport.pending).toHaveBeenCalledWith(b.id);
	});

	it("never persists a live endpoint when broker registration is rejected", async () => {
		const { transport, b } = setup();
		const root = makeActiveRoot(b);
		transport.register.mockRejectedValueOnce(new Error("registration refused"));
		await b.supervisor.sweepNativeMesh();
		expect(transport.register).toHaveBeenCalledOnce();
		expect(new NativeMeshEndpoints(root.registryDir).read("host-b", "two")).toBeUndefined();
	});

	it("stores to a freshly observed inactive remote identity but rejects a stale observation", async () => {
		const { a, b, transport } = setup();
		makePassive(b);
		await a.supervisor.sweepNativeMesh();
		await b.supervisor.sweepNativeMesh();
		await a.supervisor.sweepNativeMesh();
		const observation = a.supervisor.nativeObservations.get(b.id);
		expect(observation.state).toBe("inactive");
		const command = { type: "send_message", targetActiveSessionId: b.id, message: "wake me" };
		const reply = await a.supervisor.sendNativeMeshMessage(command, a.summary);
		expect(reply.data.deliveryStatus).toBe("stored");
		expect(transport.store).toHaveBeenCalledOnce();
		observation.lastHeartbeatAt = new Date(Date.now() - 91_000).toISOString();
		await expect(a.supervisor.sendNativeMeshMessage(command, a.summary)).rejects.toThrow(/unavailable/i);
		expect(transport.store).toHaveBeenCalledOnce();
	});

	it("registers and polls an inactive saved session without waking it when the queue is empty", async () => {
		const { transport, b } = setup();
		makePassive(b);
		await b.supervisor.sweepNativeMesh();
		expect(transport.register).toHaveBeenCalledWith(
			expect.objectContaining({
				hostId: "host-b",
				agentId: "two",
				state: "inactive",
			}),
		);
		expect(transport.pending).toHaveBeenCalledWith(b.id);
		expect(b.supervisor.createOrReuseWorker).not.toHaveBeenCalled();
		expect(transport.acknowledge).not.toHaveBeenCalled();
	});

	it("builds only registered passive identities and parent chains", async () => {
		const { transport, b } = setup();
		const root = makePassive(b);
		const { childId } = addPassiveChild(b, root.path);
		await b.supervisor.sweepNativeMesh();
		expect(transport.register).toHaveBeenCalledWith(
			expect.objectContaining({
				hostId: "host-b",
				agentId: "two",
				state: "inactive",
				parentId: null,
			}),
		);
		expect(transport.register).toHaveBeenCalledWith(
			expect.objectContaining({
				hostId: "host-b",
				agentId: "child",
				state: "inactive",
				parentId: b.id,
			}),
		);
		expect(transport.pending).toHaveBeenCalledWith(b.id);
		expect(transport.pending).toHaveBeenCalledWith(childId);
		expect(b.supervisor.createOrReuseWorker).not.toHaveBeenCalled();
	});

	it("rotates a 64-endpoint sweep budget across all registered passive identities", async () => {
		const { transport, b } = setup();
		// In-memory registry isolates the scheduling contract from disk I/O.
		const bindings = Array.from({ length: 100 }, (_, index) => {
			const sessionId = `saved-${index}`;
			const sessionPath = join(b.directory, `${sessionId}.jsonl`);
			return {
				machineId: "host-b",
				sessionId,
				sessionPath,
				rootPath: sessionPath,
				rootSessionId: sessionId,
				ancestors: [],
				name: sessionId,
				cwd: b.directory,
				rlmDepth: 0,
			};
		});
		b.supervisor.nativeEndpoints = { list: vi.fn(() => bindings) };
		b.supervisor.nativeLocalEndpoints = () => [];
		b.supervisor.nativeOperations = { pending: () => [] };
		b.supervisor.nativeOutbox = { pending: () => [] };
		const expected = new Set(bindings.map((binding) => nativeMeshAgentId("host-b", binding.sessionId)));
		const registered = new Set<string>();
		const polled = new Set<string>();
		for (let sweep = 0; sweep < 2; sweep++) {
			transport.register.mockClear();
			transport.pending.mockClear();
			await b.supervisor.sweepNativeMesh();
			expect(transport.register.mock.calls.length).toBeLessThanOrEqual(64);
			expect(transport.pending.mock.calls.length).toBeLessThanOrEqual(64);
			expect(transport.register.mock.calls.length).toBeGreaterThan(0);
			for (const [registration] of transport.register.mock.calls)
				registered.add(nativeMeshAgentId(registration.hostId, registration.agentId));
			for (const [id] of transport.pending.mock.calls) polled.add(id);
		}
		expect(registered).toEqual(expected);
		expect(polled).toEqual(expected);
	});

	it("keeps a registered inactive child passive when its root worker remains live", async () => {
		const { transport, b } = setup();
		const root = makePassive(b);
		const { childId, childPath } = addPassiveChild(b, root.path);
		Object.assign(b.worker.descriptor, { workerId: "root-worker" });
		b.supervisor.workers = new Map([["root-worker", b.worker]]);
		const rootSummary = { ...root.summary, cwd: b.directory };
		const childSummary = {
			...rootSummary,
			id: "child",
			activeSessionId: undefined,
			sessionId: "child",
			sessionFile: childPath,
			sessionName: "child",
			rlmDepth: 1,
			parentSessionId: "two",
		};
		b.supervisor.roster = () => ({
			values: () => [
				{ workerId: "root-worker", summary: rootSummary },
				{ workerId: "root-worker", summary: childSummary },
			],
			byActiveSessionId: () => undefined,
		});
		await b.supervisor.sweepNativeMesh();
		expect(transport.register).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "two",
				state: "active",
				parentId: null,
			}),
		);
		expect(transport.register).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "child",
				state: "inactive",
				parentId: b.id,
			}),
		);
		expect(transport.pending).toHaveBeenCalledWith(childId);
		expect(b.supervisor.createOrReuseWorker).not.toHaveBeenCalled();
	});

	it("never registers or polls an unregistered historical session even if present in the catalog", async () => {
		const { transport, b } = setup();
		const root = makePassive(b);
		const historyPath = join(b.directory, "history.jsonl");
		writeFileSync(
			historyPath,
			`${JSON.stringify({ type: "session", version: 3, id: "history", timestamp: new Date().toISOString(), cwd: b.directory })}\n`,
		);
		const history = { ...root.info, id: "history", path: historyPath, name: "history" };
		b.supervisor.catalog.list.mockResolvedValue([root.info, history]);
		const historyId = nativeMeshAgentId("host-b", "history");
		await b.supervisor.sweepNativeMesh();
		await b.supervisor.sweepNativeMesh();
		expect(transport.register).toHaveBeenCalledWith(expect.objectContaining({ agentId: "two", state: "inactive" }));
		expect(transport.register).not.toHaveBeenCalledWith(expect.objectContaining({ agentId: "history" }));
		expect(transport.pending).not.toHaveBeenCalledWith(historyId);
		expect(b.supervisor.nativeEndpoints.read("host-b", "history")).toBeUndefined();
		expect(b.supervisor.createOrReuseWorker).not.toHaveBeenCalled();
	});

	it("wakes for pending mail and acknowledges only after the matching persistence frame", async () => {
		const { transport, a, b } = setup();
		const passive = makePassive(b);
		let replyToWorker!: (value: { success: boolean }) => void;
		b.recipient.requestWorker.mockImplementation(
			() =>
				new Promise((resolve) => {
					replyToWorker = resolve;
				}),
		);
		await a.supervisor.sweepNativeMesh();
		await b.supervisor.sweepNativeMesh();
		await a.supervisor.sweepNativeMesh();
		await a.supervisor.sendNativeMeshMessage(
			{ type: "send_message", targetActiveSessionId: b.id, message: "wake me" },
			a.summary,
		);
		await b.supervisor.sweepNativeMesh();
		await vi.waitFor(() => expect(b.recipient.requestWorker).toHaveBeenCalledOnce());
		expect(b.supervisor.createOrReuseWorker).toHaveBeenCalledWith(
			"native-mesh",
			expect.objectContaining({
				type: "create",
				sessionPath: passive.path,
				continueRecent: false,
			}),
		);
		const delivery = b.recipient.requestWorker.mock.calls[0]![0] as any;
		expect(delivery).toMatchObject({
			type: "worker_native_mesh_deliver_message",
			expectedSessionId: "two",
			message: "wake me",
		});
		expect(transport.acknowledge).not.toHaveBeenCalled();
		frame(b.supervisor, b.worker, b.recipient, "native_mesh_message_persisted", delivery.requestId, "wrong-token");
		frame(
			b.supervisor,
			b.worker,
			{ requestWorker: vi.fn() },
			"native_mesh_message_persisted",
			delivery.requestId,
			delivery.attemptToken,
		);
		expect(transport.acknowledge).not.toHaveBeenCalled();
		frame(
			b.supervisor,
			b.worker,
			b.recipient,
			"native_mesh_message_persisted",
			delivery.requestId,
			delivery.attemptToken,
		);
		await settle();
		expect(transport.acknowledge).toHaveBeenCalledExactlyOnceWith(delivery.requestId);
		// A persistence frame can arrive before requestWorker returns.
		replyToWorker({ success: true });
		await settle();
	});

	it("delivers old pending mail for a registered target and ACKs only after persistence", async () => {
		const { transport, messages, a, b } = setup();
		makePassive(b);
		await a.supervisor.sweepNativeMesh();
		await b.supervisor.sweepNativeMesh();
		const stored = await transport.store({ from: a.id, to: b.id, text: "old pending", callerMessageId: "old-op" });
		// Simulate an item stored long before this supervisor restarted. It remains in
		// the broker queue; neither the test nor the supervisor removes it manually.
		messages.get(stored.requestId).createdAt = "2000-01-01T00:00:00.000Z";
		await b.supervisor.sweepNativeMesh();
		await vi.waitFor(() => expect(b.recipient.requestWorker).toHaveBeenCalledOnce());
		const delivery = b.recipient.requestWorker.mock.calls[0]![0] as any;
		expect(delivery).toMatchObject({ requestId: stored.requestId, expectedSessionId: "two", message: "old pending" });
		expect(transport.acknowledge).not.toHaveBeenCalled();
		expect((await transport.pending(b.id)).map((m: any) => m.requestId)).toContain(stored.requestId);
		frame(
			b.supervisor,
			b.worker,
			b.recipient,
			"native_mesh_message_persisted",
			delivery.requestId,
			delivery.attemptToken,
		);
		await settle();
		expect(transport.acknowledge).toHaveBeenCalledExactlyOnceWith(stored.requestId);
		expect(await transport.pending(b.id)).toEqual([]);
		expect(messages.get(stored.requestId)).toMatchObject({
			text: "old pending",
			createdAt: "2000-01-01T00:00:00.000Z",
			acknowledgedAt: expect.any(String),
		});
	});

	it("coalesces concurrent wakes for two registered targets under one root without losing either message", async () => {
		const { transport, a, b } = setup();
		const root = makePassive(b);
		const { childId } = addPassiveChild(b, root.path);
		await a.supervisor.sweepNativeMesh();
		await b.supervisor.sweepNativeMesh();
		const first = await transport.store({ from: a.id, to: b.id, text: "root mail", callerMessageId: "root-op" });
		const second = await transport.store({
			from: b.id,
			to: childId,
			text: "child mail",
			callerMessageId: "child-op",
		});
		// Keep createOrReuseWorker and its per-path opening lock real. Only the
		// process launch is held at a barrier so the other endpoint can join it.
		delete b.supervisor.createOrReuseWorker;
		b.supervisor.defaultSessionConfig = { agentDir: b.directory };
		b.supervisor.activeSessionMoves = new Set();
		b.supervisor.openingWorkers = new Map();
		b.supervisor.catalogOpeningWorkers = new Map();
		b.supervisor.matchWorkers = vi.fn(() => []);
		b.supervisor.findWorkerBySessionFile = vi.fn(() => undefined);
		let release!: (worker: typeof b.worker) => void;
		const workerReady = new Promise<typeof b.worker>((resolve) => {
			release = resolve;
		});
		b.supervisor.launchWorker = vi.fn(() => workerReady);
		const join = vi.spyOn(b.supervisor, "joinOpeningWorker");
		const sweeping = b.supervisor.sweepNativeMesh();
		await vi.waitFor(() => expect(join).toHaveBeenCalledOnce());
		expect(b.supervisor.launchWorker).toHaveBeenCalledOnce();
		release(b.worker);
		await sweeping;
		await vi.waitFor(() => expect(b.recipient.requestWorker).toHaveBeenCalledTimes(2));
		expect(b.supervisor.launchWorker).toHaveBeenCalledOnce();
		const deliveries = b.recipient.requestWorker.mock.calls.map((call: any[]) => call[0]);
		expect(deliveries).toHaveLength(2);
		expect(deliveries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ requestId: first.requestId, expectedSessionId: "two", message: "root mail" }),
				expect.objectContaining({ requestId: second.requestId, expectedSessionId: "child", message: "child mail" }),
			]),
		);
		expect(transport.acknowledge).not.toHaveBeenCalled();
		for (const delivery of deliveries)
			frame(
				b.supervisor,
				b.worker,
				b.recipient,
				"native_mesh_message_persisted",
				delivery.requestId,
				delivery.attemptToken,
			);
		await settle();
		expect(transport.acknowledge).toHaveBeenCalledTimes(2);
		expect(transport.acknowledge).toHaveBeenCalledWith(first.requestId);
		expect(transport.acknowledge).toHaveBeenCalledWith(second.requestId);
		expect(await transport.pending(b.id)).toEqual([]);
		expect(await transport.pending(childId)).toEqual([]);
	});

	it("does not block sweeps or start another wake while a timed-out passive wake is still running", async () => {
		const { transport, a, b } = setup();
		makePassive(b);
		const liveId = nativeMeshAgentId("host-b", "live");
		const live = {
			id: liveId,
			parentId: null,
			summary: {
				...b.summary,
				sessionId: "live",
				activeSessionId: "active-live",
				sessionName: "live",
				cwd: b.directory,
			},
			worker: { client: { requestWorker: vi.fn(async () => ({ success: true })) }, nativeMeshDeliveryCapable: true },
		};
		b.supervisor.nativeLocalEndpoints = () => [live];
		// The unrelated live endpoint is only needed to test sweep progress.
		b.supervisor.nativeEndpointBinding = () => undefined;
		await a.supervisor.sweepNativeMesh();
		await b.supervisor.sweepNativeMesh();
		const stored = await transport.store({
			from: a.id,
			to: b.id,
			text: "blocked wake",
			callerMessageId: "blocked-op",
		});
		let release!: (worker: typeof b.worker) => void;
		const blocked = new Promise<typeof b.worker>((resolve) => {
			release = resolve;
		});
		b.supervisor.createOrReuseWorker.mockImplementationOnce(() => blocked).mockImplementation(async () => b.worker);
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		try {
			let finished = false;
			void b.supervisor.sweepNativeMesh().then(() => {
				finished = true;
			});
			await vi.waitFor(() => expect(finished).toBe(true));
			await vi.waitFor(() => expect(b.supervisor.createOrReuseWorker).toHaveBeenCalledOnce());
			expect(transport.acknowledge).not.toHaveBeenCalled();
			transport.discover.mockClear();
			transport.pending.mockClear();
			await b.supervisor.sweepNativeMesh();
			expect(transport.discover).toHaveBeenCalled();
			expect(transport.pending).toHaveBeenCalledWith(liveId);
			expect(b.supervisor.createOrReuseWorker).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(30_001);
			await b.supervisor.sweepNativeMesh();
			await b.supervisor.sweepNativeMesh();
			expect(b.supervisor.createOrReuseWorker).toHaveBeenCalledOnce();
			expect(transport.acknowledge).not.toHaveBeenCalled();
			expect((await transport.pending(b.id)).map((m: any) => m.requestId)).toContain(stored.requestId);
			// The timeout is soft: only completion of the original wake permits a
			// later sweep to retry or hand off. It never acknowledges on timeout.
			release(b.worker);
			await settle();
			await vi.waitFor(async () => {
				await b.supervisor.sweepNativeMesh();
				expect(b.recipient.requestWorker).toHaveBeenCalled();
			});
			const delivery = b.recipient.requestWorker.mock.calls[0]![0] as any;
			expect(delivery).toMatchObject({
				requestId: stored.requestId,
				message: "blocked wake",
				expectedSessionId: "two",
			});
			expect(transport.acknowledge).not.toHaveBeenCalled();
			frame(
				b.supervisor,
				b.worker,
				b.recipient,
				"native_mesh_message_persisted",
				delivery.requestId,
				delivery.attemptToken,
			);
			await settle();
			expect(transport.acknowledge).toHaveBeenCalledExactlyOnceWith(stored.requestId);
		} finally {
			release(b.worker);
			vi.useRealTimers();
		}
	});

	it("limits blocked passive wakes to 16 while a live endpoint still receives mail", async () => {
		const { transport, a, b } = setup();
		const passive = Array.from({ length: 17 }, (_, index) => {
			const sessionId = `passive-${index}`;
			return {
				id: nativeMeshAgentId("host-b", sessionId),
				parentId: null,
				summary: { ...b.summary, sessionId, activeSessionId: undefined, sessionName: sessionId, cwd: b.directory },
			};
		});
		const liveId = nativeMeshAgentId("host-b", "live");
		const liveClient = { requestWorker: vi.fn(async (_command: any) => ({ success: true })) };
		const liveWorker = { client: liveClient, nativeMeshDeliveryCapable: true };
		const live = {
			id: liveId,
			parentId: null,
			summary: {
				...b.summary,
				sessionId: "live",
				activeSessionId: "active-live",
				sessionName: "live",
				cwd: b.directory,
			},
			worker: liveWorker,
		};
		b.supervisor.nativeLocalEndpoints = () => [live];
		b.supervisor.nativePassiveEndpoints = async () => passive;
		b.supervisor.nativeEndpointBinding = () => undefined;
		await a.supervisor.sweepNativeMesh();
		for (const endpoint of [...passive, live])
			await transport.store({ from: a.id, to: endpoint.id, text: endpoint.id, callerMessageId: endpoint.id });
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		b.supervisor.wakeNativeMeshEndpoint = vi.fn(async (endpoint: any) => {
			await blocked;
			return { worker: b.worker, summary: endpoint.summary };
		});
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		try {
			await b.supervisor.sweepNativeMesh();
			await vi.waitFor(() => expect(b.supervisor.wakeNativeMeshEndpoint).toHaveBeenCalledTimes(16));
			await vi.waitFor(() => expect(liveClient.requestWorker).toHaveBeenCalledOnce());
			const liveDelivery = liveClient.requestWorker.mock.calls[0]![0] as any;
			frame(
				b.supervisor,
				liveWorker,
				liveClient,
				"native_mesh_message_persisted",
				liveDelivery.requestId,
				liveDelivery.attemptToken,
			);
			await settle();
			expect(transport.acknowledge).toHaveBeenCalledExactlyOnceWith(liveDelivery.requestId);
			await vi.advanceTimersByTimeAsync(30_001);
			await b.supervisor.sweepNativeMesh();
			expect(b.supervisor.wakeNativeMeshEndpoint).toHaveBeenCalledTimes(16);
			const started = new Set(b.supervisor.wakeNativeMeshEndpoint.mock.calls.map((call: any[]) => call[0].id));
			const deferred = passive.filter((endpoint) => !started.has(endpoint.id));
			expect(deferred).toHaveLength(1);
			expect(await transport.pending(deferred[0]!.id)).toHaveLength(1);
			expect(transport.acknowledge).toHaveBeenCalledTimes(1);
		} finally {
			// Settle every blocked handoff before fixture cleanup, without delivering
			// or acknowledging any passive message during shutdown.
			b.supervisor.shuttingDown = true;
			const handoffs = [...(b.supervisor.nativeEndpointHandoffs?.values() ?? [])] as Promise<void>[];
			release();
			await Promise.all(handoffs);
			vi.useRealTimers();
		}
	});

	it("does not hand off or ACK when shutdown starts during a blocked passive wake", async () => {
		const { transport, a, b } = setup();
		makePassive(b);
		await a.supervisor.sweepNativeMesh();
		await b.supervisor.sweepNativeMesh();
		const stored = await transport.store({ from: a.id, to: b.id, text: "shutdown", callerMessageId: "shutdown-op" });
		let release!: (worker: typeof b.worker) => void;
		const blocked = new Promise<typeof b.worker>((resolve) => {
			release = resolve;
		});
		b.supervisor.createOrReuseWorker.mockImplementation(() => blocked);
		await b.supervisor.sweepNativeMesh();
		await vi.waitFor(() => expect(b.supervisor.createOrReuseWorker).toHaveBeenCalledOnce());
		const handoff = b.supervisor.nativeEndpointHandoffs.get(b.id) as Promise<void>;
		expect(handoff).toBeDefined();
		b.supervisor.shuttingDown = true;
		release(b.worker);
		await handoff;
		expect(b.recipient.requestWorker).not.toHaveBeenCalled();
		expect(transport.acknowledge).not.toHaveBeenCalled();
		expect((await transport.pending(b.id)).map((m: any) => m.requestId)).toContain(stored.requestId);
	});

	it("does not wake for mail from an unknown identity", async () => {
		const { transport, messages, b } = setup();
		makePassive(b);
		messages.set("untrusted", {
			requestId: "untrusted",
			from: nativeMeshAgentId("unknown-host", "unknown"),
			to: b.id,
			text: "no",
			acknowledgedAt: null,
		});
		await b.supervisor.sweepNativeMesh();
		expect(transport.pending).toHaveBeenCalledWith(b.id);
		expect(b.supervisor.createOrReuseWorker).not.toHaveBeenCalled();
		expect(b.recipient.requestWorker).not.toHaveBeenCalled();
		expect(transport.acknowledge).not.toHaveBeenCalled();
	});

	it("does not hand off or acknowledge when the woken session identity does not match", async () => {
		const { transport, a, b } = setup();
		makePassive(b, "other-session");
		await a.supervisor.sweepNativeMesh();
		await b.supervisor.sweepNativeMesh();
		await a.supervisor.sweepNativeMesh();
		await a.supervisor.sendNativeMeshMessage(
			{ type: "send_message", targetActiveSessionId: b.id, message: "wake me" },
			a.summary,
		);
		await b.supervisor.sweepNativeMesh();
		await vi.waitFor(() => expect(b.supervisor.createOrReuseWorker).toHaveBeenCalledOnce());
		await settle();
		expect(b.recipient.requestWorker).not.toHaveBeenCalled();
		expect(transport.acknowledge).not.toHaveBeenCalled();
	});
});

describe("supervisor native mesh sender authorization", () => {
	function authorizationSetup() {
		const { a, b } = setup();
		a.summary.sessionName = "owned-name";
		const owner = { id: "owner" };
		const outsider = { id: "outsider" };
		const ownedWorker = {
			client: {},
			descriptor: {
				workerId: "owned",
				authenticationToken: "owned-token",
				ownerClientId: owner.id,
				rootActiveSessionId: a.summary.activeSessionId,
				lifecycle: "ready",
			},
		};
		const publicSummary = {
			...a.summary,
			id: "active-public",
			activeSessionId: "active-public",
			sessionId: "public-session",
			sessionName: "public-name",
		};
		const publicWorker = {
			client: {},
			descriptor: {
				workerId: "public",
				authenticationToken: "public-token",
				rootActiveSessionId: publicSummary.activeSessionId,
				lifecycle: "ready",
			},
		};
		const matches = [
			{ worker: ownedWorker, summary: a.summary },
			{ worker: publicWorker, summary: publicSummary },
		];
		Object.assign(a.supervisor, {
			workers: new Map([
				["owned", ownedWorker],
				["public", publicWorker],
			]),
			roster: () => ({
				byActiveSessionId: (id: string) => {
					const match = matches.find(({ summary }) => summary.activeSessionId === id);
					return match && { workerId: match.worker.descriptor.workerId, summary: match.summary };
				},
			}),
			protocolClientIds: new WeakMap(),
			refreshWorkerSummaries: vi.fn(async () => {}),
			matchWorkers: vi.fn((selector: string, include?: (worker: any) => boolean) =>
				matches.filter(
					({ worker, summary }) =>
						(!include || include(worker)) &&
						[summary.activeSessionId, summary.sessionId, summary.sessionName].includes(selector),
				),
			),
			sendNativeMeshMessage: vi.fn(async (_command: any, source: any) => ({
				success: true,
				data: { source: source.activeSessionId },
			})),
		});
		const command = {
			type: "send_message",
			id: "send",
			agentOrigin: true,
			fromActiveSessionId: a.summary.activeSessionId,
			targetActiveSessionId: b.id,
			message: "hello",
		};
		return { supervisor: a.supervisor, owner, outsider, command, ownedSummary: a.summary, publicSummary };
	}

	it("authenticates a client-owned sender even when the requesting client cannot see it", async () => {
		const { supervisor, outsider, command, ownedSummary } = authorizationSetup();
		const authorized = { ...command, workerToken: "owned-token" };
		const reply = await supervisor.handleCommand(outsider, authorized);
		expect(reply).toMatchObject({ success: true, data: { source: ownedSummary.activeSessionId } });
		expect(supervisor.sendNativeMeshMessage).toHaveBeenCalledOnce();
		expect(supervisor.sendNativeMeshMessage).toHaveBeenCalledWith(authorized, expect.objectContaining(ownedSummary));
	});

	it("rejects invalid tokens and tokens used to impersonate another worker", async () => {
		const { supervisor, owner, command, publicSummary } = authorizationSetup();
		for (const attempt of [
			{ ...command, workerToken: "wrong-token" },
			{ ...command, workerToken: "" },
			{ ...command, workerToken: "public-token" },
			{ ...command, fromActiveSessionId: publicSummary.activeSessionId, workerToken: "owned-token" },
			{ ...command, fromActiveSessionId: undefined, workerToken: "owned-token" },
		]) {
			await expect(supervisor.handleCommand(owner, attempt)).rejects.toThrow();
		}
		expect(supervisor.sendNativeMeshMessage).not.toHaveBeenCalled();
	});

	it("rejects session ID and name aliases when a worker token is present", async () => {
		const { supervisor, owner, command, ownedSummary } = authorizationSetup();
		for (const alias of [ownedSummary.sessionId, ownedSummary.sessionName]) {
			await expect(
				supervisor.handleCommand(owner, { ...command, fromActiveSessionId: alias, workerToken: "owned-token" }),
			).rejects.toThrow();
		}
		expect(supervisor.sendNativeMeshMessage).not.toHaveBeenCalled();
	});

	it("preserves client visibility rules when no token is supplied", async () => {
		const { supervisor, owner, outsider, command, ownedSummary, publicSummary } = authorizationSetup();
		await expect(supervisor.handleCommand(outsider, command)).rejects.toThrow();
		expect(supervisor.sendNativeMeshMessage).not.toHaveBeenCalled();
		await expect(supervisor.handleCommand(owner, command)).resolves.toMatchObject({ success: true });
		await expect(
			supervisor.handleCommand(outsider, { ...command, fromActiveSessionId: publicSummary.sessionName }),
		).resolves.toMatchObject({ success: true });
		expect(supervisor.sendNativeMeshMessage.mock.calls.map((call: any[]) => call[1])).toEqual([
			ownedSummary,
			publicSummary,
		]);
	});
});

describe("isolated operation recovery", () => {
	it("records failed then successful recovery without stopping inbound discovery", async () => {
		const { a, transport } = setup();
		const record = vi.spyOn(nativeMeshDiagnostic, "record").mockImplementation(() => {});
		const inspect = vi.spyOn(a.supervisor.nativeOperations, "inspectRecovery").mockImplementationOnce(() => {
			throw new Error("private journal error");
		});
		try {
			await a.supervisor.sweepNativeMesh();
			await a.supervisor.sweepNativeMesh();
			expect(transport.discover).toHaveBeenCalledTimes(2);
			expect(transport.pending).toHaveBeenCalledTimes(2);
			const events = record.mock.calls.map(([event]) => event).filter((event) => event.stage === "outbox-recovery");
			expect(events.map((event) => event.status)).toEqual(["start", "failure", "start", "success"]);
			const recoveryLogs = a.supervisor.log.mock.calls
				.map((call: any[]) => call[0])
				.filter((message: string) => message.startsWith("Native mesh journal recovery"));
			expect(recoveryLogs).toEqual([
				"Native mesh journal recovery scan blocked; inbound synchronization continues",
				"Native mesh journal recovery scan clear; sends may still fail",
			]);
		} finally {
			inspect.mockRestore();
			record.mockRestore();
		}
	});
	it("keeps invalid identity on disk, recovers a valid binding and continues inbound sweep", async () => {
		const { a, transport } = setup();
		const valid = { from: a.id, to: nativeMeshAgentId("remote", "good"), text: "safe", operationId: "valid" };
		const good = a.supervisor.nativeOperations.bind(valid);
		const bad = a.supervisor.nativeOperations.bind({ ...valid, operationId: "bad" });
		a.supervisor.nativeOutbox.enqueue({ from: valid.from, to: valid.to, text: valid.text, callerMessageId: "bad" });
		const path = join(a.directory, "operations", `${bad}.json`);
		const old = JSON.parse(readFileSync(path, "utf8"));
		old.operationId = "mismatch";
		writeFileSync(path, JSON.stringify(old));
		const damaged = readFileSync(path, "utf8");
		await a.supervisor.sweepNativeMesh();
		await settle();
		expect(readFileSync(path, "utf8")).toBe(damaged);
		expect(a.supervisor.nativeOutbox.pending()).toContain(bad);
		expect(existsSync(join(a.directory, "operations", `${bad}.stored`))).toBe(false);
		await expect(a.supervisor.sendNativeOutbox(bad)).rejects.toThrow();
		expect(transport.discover).toHaveBeenCalledTimes(1);
		expect(transport.pending).toHaveBeenCalledTimes(1);
		expect(transport.store).toHaveBeenCalledTimes(1);
		expect(transport.store.mock.calls[0]![0].callerMessageId).toBe("valid");
		expect(a.supervisor.nativeOperations.read(good).operationId).toBe("valid");
		expect(a.supervisor.log.mock.calls.map((x: any[]) => x[0]).join(" ")).not.toContain("mismatch");
	});
	it("blocks conflicting, invalid-marker, and unbound outbox entries before network send", async () => {
		const { a, transport } = setup();
		const base = { from: a.id, to: nativeMeshAgentId("remote", "good"), text: "safe", operationId: "valid" };
		const id = a.supervisor.nativeOperations.bind(base);
		a.supervisor.nativeOutbox.enqueue({
			from: base.from,
			to: base.to,
			text: "different",
			callerMessageId: base.operationId,
		});
		await a.supervisor.sweepNativeMesh();
		await settle();
		expect(transport.store).not.toHaveBeenCalled();
		expect(a.supervisor.nativeOutbox.pending()).toContain(id);
		expect(transport.pending).toHaveBeenCalledTimes(1);
		const bad = a.supervisor.nativeOperations.bind({ ...base, operationId: "marker" });
		a.supervisor.nativeOutbox.enqueue({ from: base.from, to: base.to, text: base.text, callerMessageId: "marker" });
		writeFileSync(join(a.directory, "operations", `${bad}.stored`), "invalid");
		const legacy = a.supervisor.nativeOutbox.enqueue({
			from: base.from,
			to: base.to,
			text: base.text,
			callerMessageId: "unbound",
		});
		await a.supervisor.sweepNativeMesh();
		await settle();
		expect(transport.store).not.toHaveBeenCalled();
		expect(a.supervisor.nativeOutbox.pending()).toEqual(expect.arrayContaining([id, bad, legacy]));
		expect(transport.pending).toHaveBeenCalledTimes(2);
	});
	it.skipIf(process.platform === "win32")("does not treat a dangling marker symlink as an absent marker", async () => {
		const { a, transport } = setup();
		const base = { from: a.id, to: nativeMeshAgentId("remote", "good"), text: "safe", operationId: "symlink" };
		const id = a.supervisor.nativeOperations.bind(base);
		a.supervisor.nativeOutbox.enqueue({
			from: base.from,
			to: base.to,
			text: base.text,
			callerMessageId: base.operationId,
		});
		symlinkSync(join(a.directory, "absent"), join(a.directory, "operations", `${id}.stored`));
		await a.supervisor.sweepNativeMesh();
		await settle();
		expect(transport.store).not.toHaveBeenCalled();
		expect(transport.pending).toHaveBeenCalledTimes(1);
		expect(a.supervisor.nativeOutbox.pending()).toContain(id);
	});
	it("retains the outbox if its binding disappears while a store is in flight", async () => {
		const { a, transport } = setup();
		const base = { from: a.id, to: nativeMeshAgentId("remote", "good"), text: "safe", operationId: "race" };
		const id = a.supervisor.nativeOperations.bind(base);
		a.supervisor.nativeOutbox.enqueue({
			from: base.from,
			to: base.to,
			text: base.text,
			callerMessageId: base.operationId,
		});
		transport.store.mockImplementationOnce(async () => {
			rmSync(join(a.directory, "operations", `${id}.json`));
			return { requestId: id, deliveryStatus: "stored" as const };
		});
		await expect(a.supervisor.sendNativeOutbox(id)).rejects.toThrow();
		expect(a.supervisor.nativeOutbox.pending()).toContain(id);
		expect(existsSync(join(a.directory, "operations", `${id}.stored`))).toBe(false);
	});
	it("directory scan failure blocks outbox but not discovery or pending", async () => {
		const { a, transport } = setup();
		a.supervisor.nativeOperations.inspectRecovery = () => {
			throw new Error("secret");
		};
		await a.supervisor.sweepNativeMesh();
		expect(transport.discover).toHaveBeenCalledTimes(1);
		expect(transport.pending).toHaveBeenCalledTimes(1);
		expect(transport.store).not.toHaveBeenCalled();
		expect(a.supervisor.log.mock.calls.map((x: any[]) => x[0]).join(" ")).not.toContain("secret");
	});
});
