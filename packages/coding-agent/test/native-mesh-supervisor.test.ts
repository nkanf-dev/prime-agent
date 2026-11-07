import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { nativeMeshDiagnostic } from "../src/modes/daemon/native-mesh/diagnostic.js";
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
			expect(a.supervisor.log.mock.calls.map((call: any[]) => call[0])).toEqual([
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
