import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
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
