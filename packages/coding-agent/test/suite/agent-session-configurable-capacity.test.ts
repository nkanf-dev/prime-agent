import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	createAgentSessionMessage,
	createAgentSessionMessagePrompt,
} from "../../src/core/agent-messages.js";
import type { Harness } from "./harness.js";

async function freshHarness() {
	vi.resetModules();
	const { createHarness } = await import("./harness.js");
	return createHarness();
}

const envName = "PRIME_AGENT_MESSAGE_MAX_PENDING_PER_SESSION";
const capacityError = "Target session has too many pending messages";

function agentMessage(harness: Harness, index: number) {
	return {
		id: `config-capacity-${index}`,
		source: AGENT_MESSAGE_SOURCE as typeof AGENT_MESSAGE_SOURCE,
		message: `message ${index}`,
		target: { activeSessionId: "target", sessionId: harness.session.sessionId },
	};
}
function queueAgent(harness: Harness, index: number) {
	const payload = agentMessage(harness, index);
	return harness.session.queueAgentMessagePrompt(
		createAgentSessionMessagePrompt(payload),
		"followUp",
		createAgentSessionMessage(payload),
	);
}

describe("configurable agent-message unfinished capacity", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.unstubAllEnvs();
	});

	it("defaults to 20 and freezes the value at session construction", async () => {
		vi.stubEnv(envName, undefined);
		const harness = await freshHarness();
		harnesses.push(harness);
		const pause = harness.session.acquireQueuedWorkPause();
		vi.stubEnv(envName, "10000");
		for (let i = 0; i < 20; i++) await expect(queueAgent(harness, i)).resolves.toBe(true);
		await expect(queueAgent(harness, 20)).rejects.toThrow(capacityError);
		harness.session.dispose();
		pause.release();
	});

	it.each([
		"",
		" ",
		"no",
		"-1",
		"-0",
		"0",
		"+1",
		"1.5",
		"1e3",
		"0x10",
		" 20",
		"20 ",
		"Infinity",
		"9007199254740992",
		"9999999999999999999999999999",
	])("rejects invalid configured value %j rather than falling back", async (value) => {
		vi.stubEnv(envName, value);
		vi.resetModules();
		const { getAgentMessageMaxPendingPerSession } = await import("../../src/core/agent-messages.js");
		expect(() => getAgentMessageMaxPendingPerSession()).toThrow(envName);
		expect(() => getAgentMessageMaxPendingPerSession()).toThrow(envName);
	});

	it("accepts the maximum safe positive integer", async () => {
		vi.stubEnv(envName, String(Number.MAX_SAFE_INTEGER));
		vi.resetModules();
		const { getAgentMessageMaxPendingPerSession } = await import("../../src/core/agent-messages.js");
		expect(getAgentMessageMaxPendingPerSession()).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("fails closed at session construction when the configuration is invalid", async () => {
		vi.stubEnv(envName, "-1");
		vi.resetModules();
		const { AgentSession } = await import("../../src/core/agent-session.js");
		expect(() => new AgentSession({} as ConstructorParameters<typeof AgentSession>[0])).toThrow(envName);
	});

	it.each(["20", "10000"])(
		"reports the same %s limit enforced by admission",
		async (value) => {
			vi.stubEnv(envName, value);
			const harness = await freshHarness();
			harnesses.push(harness);
			const { AgentDaemon } = await import("../../src/modes/daemon/daemon-mode.js");
			const daemon = Object.create(AgentDaemon.prototype) as {
				agentMessagesPaused: boolean;
				getAgentMessageSafetyStatus(): { maxPendingPerSession: number };
			};
			daemon.agentMessagesPaused = false;
			const limit = Number(value);
			expect(daemon.getAgentMessageSafetyStatus().maxPendingPerSession).toBe(limit);
			const pause = harness.session.acquireQueuedWorkPause();
			harness.session.restorePendingNextTurnMessages(
				Array.from({ length: limit - 1 }, (_, i) => createAgentSessionMessage(agentMessage(harness, i))),
			);
			await expect(queueAgent(harness, limit - 1)).resolves.toBe(true);
			await expect(queueAgent(harness, limit)).rejects.toThrow(capacityError);
			harness.session.dispose();
			pause.release();
		},
		20000,
	);

	it("admits exactly 10000 distinct pending records when configured", async () => {
		vi.stubEnv(envName, "10000");
		const harness = await freshHarness();
		harnesses.push(harness);
		const pause = harness.session.acquireQueuedWorkPause();
		harness.session.restorePendingNextTurnMessages(
			Array.from({ length: 9999 }, (_, i) => createAgentSessionMessage(agentMessage(harness, i))),
		);
		await expect(queueAgent(harness, 9999)).resolves.toBe(true);
		await expect(queueAgent(harness, 10000)).rejects.toThrow(capacityError);
		harness.session.dispose();
		pause.release();
	}, 20000);

	it("atomically enforces a configured limit under concurrent admissions", async () => {
		vi.stubEnv(envName, "3");
		const harness = await freshHarness();
		harnesses.push(harness);
		const pause = harness.session.acquireQueuedWorkPause();
		const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => queueAgent(harness, i)));
		expect(results.filter((result) => result.status === "fulfilled" && result.value === true)).toHaveLength(3);
		const rejected = results.filter((result) => result.status === "rejected");
		expect(rejected).toHaveLength(7);
		for (const result of rejected) {
			if (result.status === "rejected") expect(String(result.reason)).toContain(capacityError);
		}
		expect(harness.session.unfinishedActionCount).toBe(3);
		harness.session.dispose();
		pause.release();
	});
});
