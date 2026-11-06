import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, getBundledSkillsDir } from "../src/config.js";
import {
	type AgentFamilyMember,
	type AgentSessionMessageController,
	createAgentMessageHostHandlers,
} from "../src/core/agent-messages.js";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { HostRequestHandlers, KernelSentAgentMessage } from "../src/core/kernel/index.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { PythonSkillRuntimeInfo } from "../src/core/skills.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";

/** Runtime info for a bundled Python skill, e.g. ("agent-message", "agent_message"). */
function bundledSkill(name: string, importName: string): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), name);
	return { name, importName, packagePath, pyprojectPath: join(packagePath, "pyproject.toml") };
}

const bundledAgentMessageSkill = () => bundledSkill("agent-message", "agent_message");

describe("agent-message skill over the kernel host bridge", () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-agent-message-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		vi.stubEnv(ENV_AGENT_DIR, tempDir);
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it.each([
		[{ receiver_role: "parent" }, ["parent"]],
		[{ receiver_role: "sibling", receiver_name: "sibling" }, ["sibling"]],
		[{ receiver_role: "child", receiver_name: "child" }, ["child"]],
		[{ receiver_name: "outside-family" }, ["outside-family"]],
		[{ receiver_name: "external-id" }, ["external-id"]],
		[{ receiver_role: "child", receiver_name: "outside-family" }, []],
		[{ target: "all" }, ["parent", "sibling", "child"]],
	] as const)("carries the real host target %j through the worker", async (selectors, expected) => {
		const daemon = new AgentDaemon(join(tempDir, "worker.sock"), {
			defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
			createRuntime: async () => {
				throw new Error("unused runtime");
			},
			worker: { authenticationToken: "test" },
		});
		const state = {
			activeSessionId: "self",
			runtime: { session: { sessionFile: join(tempDir, "self.jsonl") } },
		} as ActiveSessionState;
		const family: AgentFamilyMember[] = ["parent", "sibling", "child"].map((relationship) => ({
			relationship: relationship as AgentFamilyMember["relationship"],
			entry: {
				id: relationship,
				name:
					"receiver_role" in selectors && selectors.receiver_role === "child" && relationship === "sibling"
						? "child"
						: undefined,
				depth: 0,
				status: "idle",
				sessionPath: join(tempDir, `${relationship}.jsonl`),
			},
		}));
		const worker = daemon as unknown as {
			agentMessageTransport: string;
			createAgentFamily(): Promise<AgentFamilyMember[]>;
			supervisorLink(): unknown;
			createAgentMessageController(getState: () => ActiveSessionState): AgentSessionMessageController;
		};
		worker.agentMessageTransport = "cotal";
		worker.createAgentFamily = async () => family;
		const targets: string[] = [];
		worker.supervisorLink = () => ({
			ensureConnected: async () => undefined,
			request: async (command: { targetSessionId: string }) => {
				targets.push(command.targetSessionId);
				return { success: true, data: { deliveryStatus: "stored" } };
			},
		});
		const handlers = createAgentMessageHostHandlers({
			...worker.createAgentMessageController(() => state),
			family: async () => family,
		});
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentMessageSkill()],
			hostHandlers: handlers,
		});
		const manager = await provisioner.ensure();
		const args = Object.entries(selectors)
			.filter(([key]) => key !== "target")
			.map(([key, value]) => `${key}=${JSON.stringify(value)}`);
		const call =
			"target" in selectors
				? `agent_message.send("all", "hello")`
				: `agent_message.send("hello", ${args.join(", ")})`;
		const result = await manager.execute(`await ${call}`);
		expect(result.status).toBe(expected.length ? "ok" : "error");
		if (!expected.length) expect(JSON.stringify(result)).toContain("No child matches");
		expect(targets).toEqual(expected);
	});

	it("sends without exposing a spoofable sender and rejects the removed roster call", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentMessageSkill()],
			hostHandlers: {
				"agent_message.send": async (payload) => {
					requests.push({ type: "agent_message.send", payload });
					return {
						id: "agentmsg-test",
						source: "agent_message",
						target: { activeSessionId: payload.receiver_name, sessionId: "session-beta", sessionName: "Beta" },
						from: { activeSessionId: "alpha", sessionId: "session-alpha" },
						message: payload.message,
						deliveryStatus: "queued",
						queuedAt: "2026-06-16T00:00:00.000Z",
					};
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import json
receipt = await agent_message.send(
    "hello beta", receiver_role="sibling", receiver_name="beta"
)
print(json.dumps({"has_list_agents": hasattr(agent_message, "list_agents"), "receipt": receipt}, sort_keys=True))
`);

		expect(result.status).toBe("ok");
		const output = JSON.parse(result.stdout.trim());
		expect(output.has_list_agents).toBe(false);
		expect(output.receipt).toMatchObject({
			id: "agentmsg-test",
			source: "agent_message",
			message: "hello beta",
			deliveryStatus: "queued",
		});
		expect(result.sentAgentMessages).toEqual([
			{
				id: "agentmsg-test",
				message: "hello beta",
				deliveryStatus: "queued",
				receiverRole: "sibling",
				target: { activeSessionId: "beta", sessionId: "session-beta", sessionName: "Beta" },
			},
		]);
		expect(requests[0]).toMatchObject({
			type: "agent_message.send",
			payload: {
				type: "agent_message.send",
				message: "hello beta",
				receiver_role: "sibling",
				receiver_name: "beta",
			},
		});
		expect(requests[0].payload).not.toHaveProperty("from");
		const named = await manager.execute(`await agent_message.send("hello name", receiver_name="Beta")`);
		expect(named.status).toBe("ok");
		expect(requests[1].payload).toMatchObject({ receiver_name: "Beta", message: "hello name" });
		expect(requests[1].payload).not.toHaveProperty("receiver_role");
	});

	it("round-trips exact operation IDs from Python through AgentSession to its controller", async () => {
		const authStorage = AuthStorage.inMemory();
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			telemetryDisabled: true,
			noBuiltinHerdrReporter: true,
			resourceLoaderOptions: { noExtensions: true, noPromptTemplates: true, noThemes: true },
		});
		const inputs: Parameters<AgentSessionMessageController["sendAgentMessage"]>[0][] = [];
		const controller: AgentSessionMessageController = {
			listAgents: () => ({ agents: [] }),
			family: async () => [
				{
					relationship: "parent",
					entry: { id: "parent-id", depth: 0, status: "idle", sessionPath: join(tempDir, "parent.jsonl") },
				},
			],
			sendAgentMessage: async (input) => {
				inputs.push(input);
				return {
					id: `receipt-${inputs.length}`,
					source: "agent_message",
					target: { activeSessionId: input.target, sessionId: "target-session" },
					message: input.message,
					deliveryStatus: "stored",
					...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
				};
			},
		};
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			agentMessageController: controller,
			prewarmIpythonKernel: false,
		});
		try {
			const handlers = (
				session as unknown as { _createKernelHostHandlers(): HostRequestHandlers }
			)._createKernelHostHandlers();
			expect(handlers["agent_message.send"]).toBeTypeOf("function");
			provisioner = new IpythonKernelProvisioner(tempDir, {
				pythonSkills: [bundledAgentMessageSkill()],
				hostHandlers: handlers,
			});
			const manager = await provisioner.ensure();
			const result = await manager.execute(`
import json
legacy = await agent_message.send("legacy", receiver_role="parent")
role = await agent_message.send("role", receiver_role="parent", operation_id=" op-é/123 ")
name = await agent_message.send("name", receiver_name="remote", operation_id=" op-é/123 ")
print(json.dumps([legacy, role, name], ensure_ascii=False))
`);
			expect(result.status).toBe("ok");
			const receipts = JSON.parse(result.stdout.trim());
			expect(receipts[0]).not.toHaveProperty("operationId");
			expect(receipts[1].operationId).toBe(" op-é/123 ");
			expect(receipts[2].operationId).toBe(" op-é/123 ");
			expect(inputs).toEqual([
				{ target: "parent-id", message: "legacy", receiverRole: "parent" },
				{ target: "parent-id", message: "role", receiverRole: "parent", operationId: " op-é/123 " },
				{ target: "remote", message: "name", targetKind: "name", operationId: " op-é/123 " },
			]);
		} finally {
			session.dispose();
		}
	});

	it("validates and passes operation IDs through the host bridge", async () => {
		const requests: Record<string, unknown>[] = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentMessageSkill()],
			hostHandlers: {
				"agent_message.send": async (payload) => {
					requests.push(payload);
					return { deliveryStatus: "stored" };
				},
			},
		});
		const manager = await provisioner.ensure();
		const result = await manager.execute(`
await agent_message.send("legacy", receiver_role="parent")
for _ in range(2):
    await agent_message.send("hello", receiver_name="remote", operation_id="op-123")
await agent_message.send("boundary", receiver_role="parent", operation_id="é" * 64)
for value in (42, "", "   ", "x\\n", "x\\x7f", "é" * 65, "\\ud800"):
    try:
        await agent_message.send("bad", receiver_role="parent", operation_id=value)
    except (TypeError, ValueError) as error:
        print(type(error).__name__)
    else:
        print("unexpected success")
try:
    await agent_message.send("all", "bad", operation_id="op-broadcast")
except ValueError as error:
    print(str(error))
`);
		expect(result.status).toBe("ok");
		expect(result.stdout.trim().split("\n")).toEqual([
			"TypeError",
			"ValueError",
			"ValueError",
			"ValueError",
			"ValueError",
			"ValueError",
			"ValueError",
			"operation_id cannot be used with broadcast",
		]);
		expect(requests).toHaveLength(4);
		expect(requests[0]).not.toHaveProperty("operation_id");
		expect(requests[1]).toMatchObject({ message: "hello", receiver_name: "remote", operation_id: "op-123" });
		expect(requests[2]).toMatchObject({ message: "hello", receiver_name: "remote", operation_id: "op-123" });
		expect(requests[3]).toMatchObject({ receiver_role: "parent", operation_id: "é".repeat(64) });
	});

	it("emits successful broadcast receipts and leaves short errors in the result", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentMessageSkill()],
			hostHandlers: {
				"agent_message.send": async (payload) => ({
					receipts: [
						{
							id: "agentmsg-root",
							source: "agent_message",
							target: { activeSessionId: "root", sessionId: "session-root" },
							message: payload.message,
							deliveryStatus: "delivered",
							deliveredAt: "2026-08-03T00:00:00.000Z",
							deliveryMode: payload.mode,
						},
						{ target: "sibling", error: "rate limited" },
					],
				}),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import json
receipt = await agent_message.send("all", "status")
print(json.dumps(receipt, sort_keys=True))
`);

		expect(result.status).toBe("ok");
		expect(JSON.parse(result.stdout.trim())).toMatchObject({
			receipts: [
				{ id: "agentmsg-root", deliveryStatus: "delivered" },
				{ target: "sibling", error: "rate limited" },
			],
		});
		expect(result.sentAgentMessages).toEqual([
			{
				id: "agentmsg-root",
				message: "status",
				deliveryStatus: "delivered",
				target: { activeSessionId: "root", sessionId: "session-root" },
			},
		]);
	});

	it("rejects broadcast combined with role selectors before reaching the host", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentMessageSkill()],
			hostHandlers: {
				"agent_message.send": async () => {
					throw new Error("should not reach host");
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try:
    await agent_message.send("all", "secret", receiver_role="sibling", receiver_name="beta")
except TypeError as error:
    print(f"TypeError: {error}")
`);
		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toBe("TypeError: broadcast cannot be combined with receiver_role/receiver_name");
	});

	it("rejects a positional name target before reaching the host", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentMessageSkill()],
			hostHandlers: {
				"agent_message.send": async () => {
					throw new Error("should not reach host");
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try:
    await agent_message.send("beta", "done")
except TypeError as error:
    print(f"TypeError: {error}")
`);
		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toBe(
			"TypeError: positional agent_message.send targets are not supported; use receiver_role and receiver_name",
		);
	});

	it("does not expose a queueable delivery mode", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentMessageSkill()],
			hostHandlers: {
				"agent_message.send": async () => {
					throw new Error("should not reach host");
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try:
    await agent_message.send("hello", receiver_role="sibling", receiver_name="beta", mode="broadcast")
except TypeError as error:
    print(f"TypeError: {error}")
`);
		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toContain("TypeError: send() got an unexpected keyword argument 'mode'");
	});

	it("captures sent messages from detached tasks after the cell is idle", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentMessageSkill()],
			hostHandlers: {
				"agent_message.send": async (payload) => ({
					id: "agentmsg-background",
					source: "agent_message",
					target: { activeSessionId: payload.receiver_name, sessionId: "session-beta", sessionName: "Beta" },
					message: payload.message,
					deliveryStatus: "delivered",
					deliveredAt: "2026-07-10T00:00:00.000Z",
					deliveryMode: payload.mode,
				}),
			},
		});

		const manager = await provisioner.ensure();
		let resolveLateMessage!: (message: KernelSentAgentMessage) => void;
		const lateMessage = new Promise<KernelSentAgentMessage>((resolve) => {
			resolveLateMessage = resolve;
		});
		const result = await manager.execute(
			`async def send_later():
    await asyncio.sleep(0.05)
    await agent_message.send("background hello", receiver_role="sibling", receiver_name="beta")

background_send = asyncio.create_task(send_later())`,
			{ onLateSentAgentMessage: (message) => resolveLateMessage(message) },
		);

		expect(result.status).toBe("ok");
		expect(result.sentAgentMessages).toBeUndefined();
		await expect(lateMessage).resolves.toEqual({
			id: "agentmsg-background",
			message: "background hello",
			deliveryStatus: "delivered",
			receiverRole: "sibling",
			target: { activeSessionId: "beta", sessionId: "session-beta", sessionName: "Beta" },
		});
	});
});

describe("rlm-heartbeat skill over the kernel host bridge", () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-rlm-heartbeat-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("round-trips create, list, update, and delete through a live kernel", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const record = (type: string) => async (payload: Record<string, unknown>) => {
			requests.push({ type, payload });
			return { heartbeat: { id: payload.id ?? "job-1", label: "tests", instruction: "check tests" } };
		};
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledSkill("rlm-heartbeat", "rlm_heartbeat")],
			hostHandlers: {
				"rlm_heartbeat.create": record("rlm_heartbeat.create"),
				"rlm_heartbeat.list": async (payload) => {
					requests.push({ type: "rlm_heartbeat.list", payload });
					return { heartbeats: [{ id: "job-1", status: "active" }] };
				},
				"rlm_heartbeat.update": record("rlm_heartbeat.update"),
				"rlm_heartbeat.delete": record("rlm_heartbeat.delete"),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import json
created = await rlm_heartbeat.create("check tests", interval="5m", label="tests", delivery_mode="follow_up")
listed = await rlm_heartbeat.list(include_inactive=True)
updated = await rlm_heartbeat.update(created["heartbeat"]["id"], status="pause")
deleted = await rlm_heartbeat.delete(created["heartbeat"]["id"])
print(json.dumps({"created": created["heartbeat"], "listed": listed["heartbeats"]}, sort_keys=True))
`);

		expect(result.status).toBe("ok");
		expect(JSON.parse(result.stdout.trim())).toMatchObject({
			created: { id: "job-1", label: "tests", instruction: "check tests" },
			listed: [{ id: "job-1", status: "active" }],
		});
		expect(requests.map((request) => request.type)).toEqual([
			"rlm_heartbeat.create",
			"rlm_heartbeat.list",
			"rlm_heartbeat.update",
			"rlm_heartbeat.delete",
		]);
		expect(requests[0].payload).toMatchObject({
			type: "rlm_heartbeat.create",
			instruction: "check tests",
			interval: "5m",
			label: "tests",
			delivery_mode: "follow_up",
		});
		expect(requests[1].payload).toMatchObject({ type: "rlm_heartbeat.list", include_inactive: true });
		expect(requests[2].payload).toMatchObject({ type: "rlm_heartbeat.update", id: "job-1", status: "pause" });
		expect(requests[3].payload).toMatchObject({ type: "rlm_heartbeat.delete", id: "job-1" });
	});

	it("rejects non-string delivery modes before calling a missing host handler", async () => {
		let hostRequestCount = 0;
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledSkill("rlm-heartbeat", "rlm_heartbeat")],
			hostHandlers: {
				"rlm_heartbeat.create": async () => {
					hostRequestCount++;
					return {};
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
for value in ([], {}):
    try:
        await rlm_heartbeat.create("check tests", delivery_mode=value)
    except TypeError as error:
        print(f"TypeError: {error}")
try:
    await rlm_heartbeat.list()
except RuntimeError as error:
    print(f"RuntimeError: {error}")
`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim().split("\n")).toEqual([
			"TypeError: delivery_mode must be str or None, got list",
			"TypeError: delivery_mode must be str or None, got dict",
			'RuntimeError: host request type "rlm_heartbeat.list" is not available in this session',
		]);
		expect(hostRequestCount).toBe(0);
	});
});

describe("goal skill over the kernel host bridge", { tags: ["kernel-heavy"] }, () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-goal-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("round-trips goal.create and goal.complete through a live kernel", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledSkill("goal", "goal")],
			hostHandlers: {
				"goal.create": async (payload) => {
					requests.push({ type: "goal.create", payload });
					return {
						goal: { objective: payload.objective, status: "active", tokens_used: 0 },
						remaining_tokens: payload.token_budget ?? null,
						completion_budget_report: null,
					};
				},
				"goal.complete": async (payload) => {
					requests.push({ type: "goal.complete", payload });
					return { goal: { objective: "ship it", status: "complete", tokens_used: 7 }, remaining_tokens: 3 };
				},
			},
		});

		const manager = await provisioner.ensure();
		const created = await manager.execute(`
import json
_created = await goal.create("ship it", token_budget=10)
print(json.dumps(_created, sort_keys=True))
`);
		expect(created.status).toBe("ok");
		expect(JSON.parse(created.stdout.trim())).toEqual({
			goal: { objective: "ship it", status: "active", tokens_used: 0 },
			remaining_tokens: 10,
			completion_budget_report: null,
		});

		const completed = await manager.execute(`
_completed = await goal.complete()
print(_completed["goal"]["status"], _completed["remaining_tokens"])
`);
		expect(completed.status).toBe("ok");
		expect(completed.stdout.trim()).toBe("complete 3");
		expect(requests.map((request) => request.type)).toEqual(["goal.create", "goal.complete"]);
		expect(requests[0].payload).toMatchObject({ type: "goal.create", objective: "ship it", token_budget: 10 });
	});

	it("surfaces host errors and missing handlers as Python exceptions", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledSkill("goal", "goal")],
			hostHandlers: {
				"goal.complete": async () => {
					throw new Error("cannot complete goal because this thread has no goal");
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import rlm as _rlm
for call in (goal.complete(), goal.get(), _rlm.host_request("goal.get", {"type": "goal.complete"})):
    try:
        await call
    except RuntimeError as error:
        print(f"RuntimeError: {error}")
`);
		expect(result.status).toBe("ok");
		// A missing handler cannot be rerouted by putting another type in the payload.
		expect(result.stdout.trim().split("\n")).toEqual([
			"RuntimeError: cannot complete goal because this thread has no goal",
			'RuntimeError: host request type "goal.get" is not available in this session',
			'RuntimeError: host request type "goal.get" is not available in this session',
		]);
	});
});
