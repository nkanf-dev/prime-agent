import { describe, expect, it, vi } from "vitest";
import { createAgentMessageHostHandlers } from "../src/core/agent-messages.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";

describe("native mesh host operation IDs", () => {
	it("forwards unchanged for role and name selectors", async () => {
		const sendAgentMessage = vi.fn(async (input: { target: string; message: string }) => ({
			id: "id",
			source: "agent_message" as const,
			target: { activeSessionId: input.target, sessionId: input.target },
			message: input.message,
			deliveryStatus: "delivered" as const,
		}));
		const handlers = createAgentMessageHostHandlers({
			family: async () => [{ relationship: "parent", entry: { id: "parent", depth: 0, status: "idle" } }],
			sendAgentMessage,
		});
		await handlers["agent_message.send"]!({ message: "hello", receiver_role: "parent", operation_id: " op α " });
		expect(sendAgentMessage).toHaveBeenLastCalledWith({
			target: "parent",
			message: "hello",
			receiverRole: "parent",
			operationId: " op α ",
		});
		await handlers["agent_message.send"]!({ message: "hello", receiver_name: "remote", operation_id: "retry" });
		expect(sendAgentMessage).toHaveBeenLastCalledWith({
			target: "remote",
			message: "hello",
			targetKind: "name",
			operationId: "retry",
		});
		await handlers["agent_message.send"]!({ message: "hello", receiver_role: "parent" });
		expect(sendAgentMessage).toHaveBeenLastCalledWith({ target: "parent", message: "hello", receiverRole: "parent" });
	});

	it("rejects invalid IDs and broadcast IDs before sending", async () => {
		const sendAgentMessage = vi.fn();
		const handlers = createAgentMessageHostHandlers({ family: async () => [], sendAgentMessage });
		for (const operation_id of [null, 123, "", " ", "line\nbreak", "\u007f", "é".repeat(65)]) {
			await expect(
				handlers["agent_message.send"]!({ message: "hello", receiver_role: "parent", operation_id }),
			).rejects.toThrow("operation_id must");
		}
		await expect(
			handlers["agent_message.send"]!({ message: "hello", target: "all", operation_id: "same" }),
		).rejects.toThrow("operation_id cannot be used with broadcast");
		expect(sendAgentMessage).not.toHaveBeenCalled();
	});

	it("forwards stable IDs to the supervisor and exposes them on success and unknown outcomes", async () => {
		const daemon = new AgentDaemon("/unused-operation-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unused runtime");
			},
			worker: { authenticationToken: "test" },
		});
		const request = vi.fn(async (_command: unknown) => ({ success: true, data: { id: "receipt" } }));
		const worker = daemon as unknown as {
			supervisorLink(): unknown;
			sendRemoteAgentSessionMessage(
				state: ActiveSessionState,
				target: string,
				message: string,
				operationId?: string,
			): Promise<{ operationId: string }>;
		};
		worker.supervisorLink = () => ({ ensureConnected: async () => undefined, request });
		const state = { activeSessionId: "sender" } as ActiveSessionState;
		const remoteTarget = `nm1-${"a".repeat(64)}`;
		const result = await worker.sendRemoteAgentSessionMessage(state, remoteTarget, "hello", " caller id ");
		expect(result.operationId).toBe(" caller id ");
		expect(request.mock.calls[0]![0]).toMatchObject({ type: "send_message", nativeMeshOperationId: " caller id " });
		const generated = await worker.sendRemoteAgentSessionMessage(state, remoteTarget, "hello");
		expect(generated.operationId).toMatch(/^[0-9a-f-]{36}$/);
		expect(request.mock.calls[1]![0]).toMatchObject({ nativeMeshOperationId: generated.operationId });
		request.mockRejectedValueOnce(new Error("timeout"));
		await expect(worker.sendRemoteAgentSessionMessage(state, remoteTarget, "hello", "retry-id")).rejects.toThrow(
			/unknown.*timeout.*retry-id.*SAME operation_id/,
		);
		await expect(
			worker.sendRemoteAgentSessionMessage(state, "local-worker", "hello", "used-remotely"),
		).rejects.toThrow("operation_id is only supported for remote native mesh messages");
		const local = await worker.sendRemoteAgentSessionMessage(state, "local-worker", "hello");
		expect(local).not.toHaveProperty("operationId");
		expect(request.mock.calls[3]![0]).not.toHaveProperty("nativeMeshOperationId");
		const localError = new Error("local timeout");
		request.mockRejectedValueOnce(localError);
		await expect(worker.sendRemoteAgentSessionMessage(state, "local-worker", "hello")).rejects.toBe(localError);
	});

	it("rejects operation IDs on resident local and cotal sends", async () => {
		const daemon = new AgentDaemon("/unused-operation-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unused runtime");
			},
			worker: { authenticationToken: "test" },
		});
		const worker = daemon as unknown as {
			agentMessageTransport: string;
			getBoundSessionState(selector: string): ActiveSessionState;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				operationId?: string;
				origin: "agent";
			}): Promise<unknown>;
		};
		worker.getBoundSessionState = () => ({ activeSessionId: "local" }) as ActiveSessionState;
		const options = {
			targetSelector: "local",
			message: "hello",
			operationId: "used-remotely",
			origin: "agent" as const,
		};
		worker.agentMessageTransport = "native";
		await expect(worker.sendAgentSessionMessage(options)).rejects.toThrow(
			"operation_id is only supported for remote native mesh messages",
		);
		worker.agentMessageTransport = "cotal";
		await expect(worker.sendAgentSessionMessage(options)).rejects.toThrow(
			"operation_id is only supported for remote native mesh messages",
		);
	});
});
