import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { isDaemonWorkerFrameHeader } from "../src/modes/daemon/daemon-worker-protocol.js";
import { nativeMeshAgentId } from "../src/modes/daemon/native-mesh/transport.js";
import { PrivateFrameDecoder } from "../src/modes/session-worker/private-framing.js";
import { createHarness } from "./suite/harness.js";
import { createDeferred } from "./suite/scheduling.js";

it("links real worker persistence to supervisor and broker after 100 retry handoffs", async () => {
	const root = mkdtempSync(join(tmpdir(), "linked-native-test-"));
	vi.stubEnv(ENV_AGENT_DIR, root);
	const entered = createDeferred(),
		release = createDeferred();
	const live = await createHarness({
		persistSession: true,
		tools: [
			{
				name: "hold",
				label: "Hold",
				description: "gate",
				parameters: Type.Object({}),
				execute: async () => {
					entered.resolve();
					await release.promise;
					return { content: [], details: {} };
				},
			},
		],
	});
	const daemon: any = new AgentDaemon(join(root, "worker.sock"), {
		defaultSessionConfig: { agentDir: root, cwd: root },
		createRuntime: async () => {
			throw Error("unused");
		},
		worker: { authenticationToken: "token" },
	});
	daemon.assertSupervisorClaimCurrent = async () => "fingerprint";
	daemon.scheduleSupervisorFenceCheck = () => {};
	daemon.scheduleRosterFlush = () => {};
	const decoder = new PrivateFrameDecoder(isDaemonWorkerFrameHeader);
	let supervisor: any, worker: any, source: any;
	const emitted: any[] = [];
	const socket: any = Object.assign(new EventEmitter(), {
		destroyed: false,
		end: vi.fn(),
		write: (data: Buffer) => {
			for (const frame of decoder.push(data)) {
				if (
					frame.header.kind === "outbound" &&
					(frame.header.outboundType === "native_mesh_message_persisted" ||
						frame.header.outboundType === "native_mesh_message_dropped")
				) {
					emitted.push(JSON.parse(frame.payload.toString("utf8")));
					supervisor.handleWorkerFrame(worker, frame, source);
				}
			}
			return true;
		},
	});
	const client: any = {
		id: "supervisor",
		socket,
		attachedActiveSessionIds: new Set(["target"]),
		detachInput: vi.fn(),
		supportsExtensionUi: false,
		capabilities: new Set(),
		transport: "private-framed",
	};
	const state: any = {
		activeSessionId: "target",
		extensionUiRequests: new Map(),
		clients: new Set(),
		pendingAttaches: 0,
		lastEventSequence: 0,
		runtime: { metadata: { kind: "subagent", createdAt: 1 }, session: live.session },
	};
	daemon.sessions.set("target", state);
	const recipient = nativeMeshAgentId("host-b", live.session.sessionId),
		sender = nativeMeshAgentId("host-a", "sender");
	const requestId = `nm1m-${"a".repeat(64)}`,
		id = `agentmsg_native-mesh:${requestId}`;
	const records = [
		{
			id: recipient,
			hostId: "host-b",
			agentId: live.session.sessionId,
			parentId: null,
			state: "active",
			name: "b",
			lastHeartbeatAt: new Date().toISOString(),
		},
		{
			id: sender,
			hostId: "host-a",
			agentId: "sender",
			parentId: null,
			state: "active",
			name: "a",
			lastHeartbeatAt: new Date().toISOString(),
		},
	];
	let acked = false,
		diskAtAck = 0;
	const broker: any = {
		register: async () => {},
		discover: async () => records,
		pending: async () => (acked ? [] : [{ requestId, from: sender, to: recipient, text: "one entry" }]),
		acknowledge: vi.fn(async () => {
			diskAtAck = readFileSync(live.session.sessionFile!, "utf8").split(`"id":"${id}"`).length - 1;
			acked = true;
		}),
	};
	const commands: any[] = [];
	let lastRequest: Promise<any> = Promise.resolve();
	source = {
		requestWorker: (command: any) => {
			commands.push(command);
			lastRequest = daemon.receiveMeshMessage(client, command).then(() => ({ success: true }));
			return lastRequest;
		},
	};
	worker = { client: source, nativeMeshDeliveryCapable: true };
	supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
		nativeMeshConfig: { machineId: "host-b", url: "http://127.0.0.1", token: "test" },
		nativeMesh: broker,
		nativeOperations: { pending: () => [] },
		nativeOutbox: { pending: () => [] },
		nativeObservations: new Map(),
		nativeAttempts: new Map(),
		nativeOutboxSends: new Set(),
		nativeLocalEndpoints: () => [
			{
				id: recipient,
				parentId: null,
				summary: { activeSessionId: "target", sessionId: live.session.sessionId, sessionName: "target" },
				worker,
			},
		],
		clearRosterStaleness: () => {},
		log: () => {},
		shuttingDown: false,
	});
	let control: Promise<any> | undefined;
	try {
		await daemon.handleLine(
			client,
			JSON.stringify({
				type: "worker_auth",
				token: "token",
				supervisorGeneration: "generation",
				supervisorPid: process.pid,
				supervisorSocketPath: join(root, "supervisor.sock"),
				agentMessageTransport: "native",
			}),
		);
		live.setResponses([
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("tool done"),
			fauxAssistantMessage("message done"),
		]);
		const accept = vi.spyOn(live.session, "acceptAgentMessagePrompt");
		const delivery = vi.spyOn(live.session, "observeAgentMessagePromptOutcome");
		control = live.session.prompt("hold tool");
		void control.catch(() => {});
		await entered.promise;
		for (let i = 0; i <= 100; i++) {
			if (i) supervisor.nativeAttempts.get(requestId).started -= 60_001;
			await supervisor.sweepNativeMesh();
			await lastRequest;
		}
		expect(commands).toHaveLength(101);
		expect(new Set(commands.map((c) => c.attemptToken)).size).toBe(101);
		expect(accept).toHaveBeenCalledTimes(1);
		expect(delivery).toHaveBeenCalledTimes(1);
		expect(live.session.hasQueuedAgentMessage(id)).toBe(true);
		expect(emitted).toEqual([]);
		expect(broker.acknowledge).not.toHaveBeenCalled();
		// Simulate delayed, invalid prior frames only: actual success frame is generated by worker below.
		for (const command of commands.slice(0, -1))
			supervisor.handleWorkerFrame(
				worker,
				{
					header: { kind: "outbound", outboundType: "native_mesh_message_persisted" },
					payload: Buffer.from(
						JSON.stringify({
							type: "native_mesh_message_persisted",
							requestId,
							attemptToken: command.attemptToken,
						}),
					),
				},
				source,
			);
		expect(broker.acknowledge).not.toHaveBeenCalled();
		const completed = live.session.waitForAgentMessagePromptCompletion(id);
		release.resolve();
		await control;
		await completed;
		live.sessionManager.flushNow();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(emitted).toEqual([
			{ type: "native_mesh_message_persisted", requestId, attemptToken: commands.at(-1).attemptToken },
		]);
		expect(broker.acknowledge).toHaveBeenCalledTimes(1);
		expect(acked).toBe(true);
		expect(diskAtAck).toBe(1);
		expect(readFileSync(live.session.sessionFile!, "utf8").split(`"id":"${id}"`).length - 1).toBe(1);
		console.log(
			"LINKED_RESULT",
			JSON.stringify({
				handoffs: commands.length,
				staleRejected: 100,
				currentToken: commands.at(-1).attemptToken,
				frames: emitted.length,
				diskAtAck,
				ackCalls: broker.acknowledge.mock.calls.length,
			}),
		);
	} finally {
		release.resolve();
		if (control) await Promise.allSettled([control]);
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		live.cleanup();
		rmSync(root, { recursive: true, force: true });
	}
});
