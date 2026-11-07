import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	createAgentSessionMessage,
	createAgentSessionMessagePrompt,
} from "../../src/core/agent-messages.js";
import type { CustomMessage } from "../../src/core/messages.js";
import type { SessionAction } from "../../src/core/session-action-store.js";
import { createHarness, type Harness } from "./harness.js";
import { createDeferred, gatedHook, withStreaming } from "./scheduling.js";

const capacityError = "Target session has too many pending messages";

type AdmissionInternals = {
	_createPreparedTurnAction(
		schedule: "steer" | "followUp",
		text: string,
		images: undefined,
		options: { prefixMessages: CustomMessage[] },
	): SessionAction;
	_admitSessionInput(action: SessionAction, options: { wake: false }): { accepted: boolean };
	_promptInjectedMessage(
		text: string,
		message: CustomMessage,
		options: { streamingBehavior: "followUp"; returnAfterAccepted: true },
	): Promise<void>;
};

function agentPrefix(harness: Harness, index: number): CustomMessage {
	return createAgentSessionMessage({
		id: `agentmsg-capacity-${index}`,
		source: AGENT_MESSAGE_SOURCE,
		message: `message ${index}`,
		target: { activeSessionId: "target", sessionId: harness.session.sessionId },
	});
}

function queueAgent(harness: Harness, index: number, lane: "steer" | "followUp" = "steer") {
	const payload = {
		id: `agentmsg-capacity-${index}`,
		source: AGENT_MESSAGE_SOURCE,
		message: `message ${index}`,
		target: { activeSessionId: "target", sessionId: harness.session.sessionId },
	};
	return harness.session.queueAgentMessagePrompt(
		createAgentSessionMessagePrompt(payload),
		lane,
		createAgentSessionMessage(payload),
	);
}

describe("agent-message unfinished capacity", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("does not count 550 ordinary queued inputs against agent capacity", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const pause = harness.session.acquireQueuedWorkPause();
		for (let i = 0; i < 550; i++) {
			await harness.session.restoreFollowUpMessage(`ordinary ${i}`);
		}
		expect(harness.session.unfinishedActionCount).toBe(550);
		for (let i = 0; i < 20; i++) await expect(queueAgent(harness, i)).resolves.toBe(true);
		await expect(queueAgent(harness, 20)).rejects.toThrow(capacityError);
		expect(harness.session.unfinishedActionCount).toBe(570);
		harness.session.dispose();
		pause.release();
	});

	it("admits at most 20 concurrent real agent actions across queued lanes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const pause = harness.session.acquireQueuedWorkPause();
		const results = await Promise.allSettled(
			Array.from({ length: 30 }, (_, i) => queueAgent(harness, i, i % 2 ? "followUp" : "steer")),
		);
		expect(results.filter((result) => result.status === "fulfilled" && result.value === true)).toHaveLength(20);
		const rejected = results.filter((result) => result.status === "rejected");
		expect(rejected).toHaveLength(10);
		for (const result of rejected) {
			if (result.status === "rejected") expect(String(result.reason)).toContain(capacityError);
		}
		expect(harness.session.unfinishedActionCount).toBe(20);
		await expect(queueAgent(harness, 30)).rejects.toThrow(capacityError);
		harness.session.dispose();
		pause.release();
	});

	it("counts restored agent actions, while clear releases only their slots", async () => {
		const source = await createHarness();
		harnesses.push(source);
		const sourcePause = source.session.acquireQueuedWorkPause();
		for (let i = 0; i < 25; i++) await source.session.restoreFollowUpMessage(`ordinary ${i}`);
		for (let i = 0; i < 20; i++) await queueAgent(source, i);
		const snapshot = source.session.getSessionActionRecoverySnapshot();
		source.session.dispose();
		sourcePause.release();

		const restored = await createHarness();
		harnesses.push(restored);
		const pause = restored.session.acquireQueuedWorkPause();
		await expect(restored.session.restoreSessionActions(snapshot)).resolves.toBe(45);
		await expect(queueAgent(restored, 20)).rejects.toThrow(capacityError);
		restored.session.clearQueuedAgentMessages();
		expect(restored.session.unfinishedActionCount).toBe(25);
		for (let i = 20; i < 40; i++) await expect(queueAgent(restored, i)).resolves.toBe(true);
		await expect(queueAgent(restored, 40)).rejects.toThrow(capacityError);
		restored.session.dispose();
		pause.release();
	});

	it("counts every distinct agent record in a restored coalesced action, not just its primary", async () => {
		const source = await createHarness();
		harnesses.push(source);
		const sourcePause = source.session.acquireQueuedWorkPause();
		await source.session.restoreFollowUpMessage("ordinary owner");
		for (let i = 0; i < 19; i++) await queueAgent(source, i);
		const snapshot = source.session.getSessionActionRecoverySnapshot();
		const owner = snapshot.actions.find((action) => action.payload.text === "ordinary owner");
		if (!owner || owner.payload.kind !== "turn") throw new Error("missing owner turn");
		const records = snapshot.actions.flatMap((action) =>
			action !== owner && action.payload.kind === "turn" ? action.payload.records : [],
		);
		expect(records).toHaveLength(19);
		owner.payload.records.push(
			...records.map((record, i) => ({
				...record,
				role: (["prefix", "next_turn", "primary"] as const)[i % 3]!,
				ownerActionId: owner.id,
			})),
		);
		snapshot.actions = [owner];
		const restored = await createHarness();
		harnesses.push(restored);
		const pause = restored.session.acquireQueuedWorkPause();
		await expect(restored.session.restoreSessionActions(snapshot)).resolves.toBe(1);
		await expect(queueAgent(restored, 19)).resolves.toBe(true);
		await expect(queueAgent(restored, 20)).rejects.toThrow(capacityError);
		restored.session.dispose();
		pause.release();
		source.session.dispose();
		sourcePause.release();
	});

	it("deduplicates the same agent message ID across distinct restored actions", async () => {
		const source = await createHarness();
		harnesses.push(source);
		const sourcePause = source.session.acquireQueuedWorkPause();
		for (let i = 0; i < 20; i++) await queueAgent(source, i);
		const snapshot = source.session.getSessionActionRecoverySnapshot();
		const [first, second] = snapshot.actions;
		if (!first || first.payload.kind !== "turn" || !second || second.payload.kind !== "turn") {
			throw new Error("missing agent turns");
		}
		second.payload.records[0]!.message = first.payload.records[0]!.message;
		const restored = await createHarness();
		harnesses.push(restored);
		const pause = restored.session.acquireQueuedWorkPause();
		await expect(restored.session.restoreSessionActions(snapshot)).resolves.toBe(20);
		await expect(queueAgent(restored, 20)).resolves.toBe(true);
		await expect(queueAgent(restored, 21)).rejects.toThrow(capacityError);
		restored.session.dispose();
		pause.release();
		source.session.dispose();
		sourcePause.release();
	});

	it("counts incoming prefixes on an ordinary primary and preserves state when over capacity", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const pause = harness.session.acquireQueuedWorkPause();
		for (let i = 0; i < 19; i++) await queueAgent(harness, i);
		const internals = harness.session as unknown as AdmissionInternals;
		const create = (ids: number[]) =>
			internals._createPreparedTurnAction("followUp", "human input", undefined, {
				prefixMessages: ids.map((id) => agentPrefix(harness, id)),
			});
		// ID 0 is already unfinished, and 19 adds exactly one distinct ID.
		expect(internals._admitSessionInput(create([0, 19, 19]), { wake: false }).accepted).toBe(true);
		const before = harness.session.getSessionActionRecoverySnapshot();
		const rejected = create([0, 20, 20]);
		const recordsBefore = structuredClone(rejected.payload);
		expect(() => internals._admitSessionInput(rejected, { wake: false })).toThrow(capacityError);
		expect(rejected.payload).toEqual(recordsBefore);
		expect(harness.session.getSessionActionRecoverySnapshot()).toEqual(before);
		harness.session.dispose();
		pause.release();
	});

	it("rejects a single incoming ordinary action carrying 21 distinct agent prefixes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const pause = harness.session.acquireQueuedWorkPause();
		const internals = harness.session as unknown as AdmissionInternals;
		const action = internals._createPreparedTurnAction("followUp", "human input", undefined, {
			prefixMessages: Array.from({ length: 21 }, (_, i) => agentPrefix(harness, i)),
		});
		const before = structuredClone(action.payload);
		expect(() => internals._admitSessionInput(action, { wake: false })).toThrow(capacityError);
		expect(action.payload).toEqual(before);
		expect(harness.session.unfinishedActionCount).toBe(0);
		harness.session.dispose();
		pause.release();
	});

	it.each(["prompt", "injected"] as const)(
		"transfers restored parked prefixes to a visible queued %s without re-admitting them",
		async (path) => {
			for (const count of [20, 21, 25]) {
				const harness = await createHarness();
				harnesses.push(harness);
				const pause = harness.session.acquireQueuedWorkPause();
				const ordinary: CustomMessage = {
					role: "custom",
					customType: "context",
					content: "context",
					display: false,
					timestamp: 1,
				};
				const pending = [
					ordinary,
					...Array.from({ length: count }, (_, i) => agentPrefix(harness, i)),
					agentPrefix(harness, 0),
				];
				harness.session.restorePendingNextTurnMessages(pending);
				await expect(queueAgent(harness, count)).rejects.toThrow(capacityError);
				withStreaming(harness, true);
				pause.release();
				if (path === "prompt") {
					await harness.session.prompt("human input", { streamingBehavior: "followUp" });
				} else {
					await (harness.session as unknown as AdmissionInternals)._promptInjectedMessage("injected", ordinary, {
						streamingBehavior: "followUp",
						returnAfterAccepted: true,
					});
				}
				expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual([]);
				const actions = harness.session.getSessionActionRecoverySnapshot().actions;
				expect(actions).toHaveLength(1);
				const payload = actions[0]!.payload;
				if (payload.kind !== "turn") throw new Error("missing turn");
				expect(
					payload.records.filter((record) => record.role === "prefix").map((record) => record.message),
				).toEqual(pending);
				await expect(queueAgent(harness, count)).rejects.toThrow(capacityError);
				withStreaming(harness, false);
				harness.session.dispose();
				pause.release();
			}
		},
	);

	it.each(["prompt", "injected"] as const)(
		"rejects a new 21st agent on %s admission and restores parked prefixes in order",
		async (path) => {
			const harness = await createHarness();
			harnesses.push(harness);
			const pause = harness.session.acquireQueuedWorkPause();
			const ordinary: CustomMessage = {
				role: "custom",
				customType: "context",
				content: "context",
				display: false,
				timestamp: 1,
			};
			const pending = [
				ordinary,
				...Array.from({ length: 20 }, (_, i) => agentPrefix(harness, i)),
				agentPrefix(harness, 0),
				ordinary,
			];
			harness.session.restorePendingNextTurnMessages(pending);
			const before = harness.session.getSessionActionRecoverySnapshot();
			withStreaming(harness, true);
			pause.release();
			const newAgent = agentPrefix(harness, 20);
			const call =
				path === "prompt"
					? harness.session.acceptAgentMessagePrompt("new agent", {
							streamingBehavior: "followUp",
							customMessage: newAgent,
						})
					: (harness.session as unknown as AdmissionInternals)._promptInjectedMessage("new agent", newAgent, {
							streamingBehavior: "followUp",
							returnAfterAccepted: true,
						});
			await expect(call).rejects.toThrow(capacityError);
			expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual(pending);
			expect(harness.session.getSessionActionRecoverySnapshot()).toEqual(before);
			withStreaming(harness, false);
			harness.session.dispose();
			pause.release();
		},
	);

	it.each(["prompt", "injected"] as const)(
		"restores parked prefixes once on a pre-enqueue %s exception",
		async (path) => {
			const harness = await createHarness();
			harnesses.push(harness);
			const pending = [agentPrefix(harness, 0), agentPrefix(harness, 1), agentPrefix(harness, 0)];
			harness.session.restorePendingNextTurnMessages(pending);
			withStreaming(harness, true);
			const internals = harness.session as unknown as AdmissionInternals;
			const spy = vi.spyOn(internals, "_admitSessionInput").mockImplementation(() => {
				throw new Error("before enqueue");
			});
			const ordinary: CustomMessage = {
				role: "custom",
				customType: "context",
				content: "context",
				display: false,
				timestamp: 1,
			};
			try {
				const call =
					path === "prompt"
						? harness.session.prompt("human input", { streamingBehavior: "followUp" })
						: internals._promptInjectedMessage("injected", ordinary, {
								streamingBehavior: "followUp",
								returnAfterAccepted: true,
							});
				await expect(call).rejects.toThrow("before enqueue");
				expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual(pending);
				expect(harness.session.getSessionActionRecoverySnapshot().actions).toEqual([]);
			} finally {
				spy.mockRestore();
				withStreaming(harness, false);
				harness.session.dispose();
			}
		},
	);

	it.each(["prompt", "injected"] as const)(
		"does not restore parked prefixes twice when %s enqueue is cancelled by a listener and emission throws",
		async (path) => {
			const harness = await createHarness();
			harnesses.push(harness);
			const pending = [agentPrefix(harness, 0), agentPrefix(harness, 1), agentPrefix(harness, 0)];
			harness.session.restorePendingNextTurnMessages(pending);
			withStreaming(harness, true);
			let mutation: string | undefined;
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "session_action_update" || event.actions.followUps.length === 0) return;
				const text = event.actions.followUps[0]!;
				mutation = harness.session.mutateQueuedMessage("followUp", 0, text, { type: "delete" });
			});
			const internals = harness.session as unknown as AdmissionInternals & { _emitQueueUpdate(): void };
			const originalEmit = internals._emitQueueUpdate.bind(harness.session);
			let first = true;
			const spy = vi.spyOn(internals, "_emitQueueUpdate").mockImplementation(() => {
				const shouldThrow = first;
				first = false;
				originalEmit();
				if (shouldThrow) throw new Error("after enqueue");
			});
			const ordinary: CustomMessage = {
				role: "custom",
				customType: "context",
				content: "context",
				display: false,
				timestamp: 1,
			};
			try {
				const call =
					path === "prompt"
						? harness.session.prompt("human input", { streamingBehavior: "followUp" })
						: internals._promptInjectedMessage("injected", ordinary, {
								streamingBehavior: "followUp",
								returnAfterAccepted: true,
							});
				await expect(call).rejects.toThrow("after enqueue");
				expect(mutation).toBe("applied");
				expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual(pending);
				expect(harness.session.getSessionActionRecoverySnapshot().actions).toEqual([]);
			} finally {
				spy.mockRestore();
				unsubscribe();
				withStreaming(harness, false);
				harness.session.dispose();
			}
		},
	);

	it.each(["prompt", "injected"] as const)(
		"concurrent %s transfers and new agents retain each parked prefix and enforce capacity",
		async (path) => {
			const harness = await createHarness();
			harnesses.push(harness);
			const pause = harness.session.acquireQueuedWorkPause();
			const pending = Array.from({ length: 19 }, (_, i) => agentPrefix(harness, i));
			harness.session.restorePendingNextTurnMessages(pending);
			const ordinary: CustomMessage = {
				role: "custom",
				customType: "context",
				content: "context",
				display: false,
				timestamp: 1,
			};
			withStreaming(harness, true);
			pause.release();
			const transfer =
				path === "prompt"
					? harness.session.prompt("human input", { streamingBehavior: "followUp" })
					: (harness.session as unknown as AdmissionInternals)._promptInjectedMessage("injected", ordinary, {
							streamingBehavior: "followUp",
							returnAfterAccepted: true,
						});
			const [transferResult, ...agents] = await Promise.allSettled([
				transfer,
				...[19, 20, 21].map((i) => queueAgent(harness, i)),
			]);
			expect(transferResult.status).toBe("fulfilled");
			expect(agents.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			expect(agents.filter((result) => result.status === "rejected")).toHaveLength(2);
			expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual([]);
			const actions = harness.session.getSessionActionRecoverySnapshot().actions;
			const prefixes = actions.flatMap((action) =>
				action.payload.kind === "turn"
					? action.payload.records.filter((record) => record.role === "prefix").map((record) => record.message)
					: [],
			);
			expect(prefixes).toEqual(pending);
			withStreaming(harness, false);
			harness.session.dispose();
			pause.release();
		},
	);

	it("allows ordinary and duplicate-only inputs even when 20 distinct IDs are unfinished", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const pause = harness.session.acquireQueuedWorkPause();
		for (let i = 0; i < 20; i++) await queueAgent(harness, i);
		const internals = harness.session as unknown as AdmissionInternals;
		for (const ids of [[], [0, 0, 19]]) {
			const action = internals._createPreparedTurnAction("followUp", "ordinary", undefined, {
				prefixMessages: ids.map((id) => agentPrefix(harness, id)),
			});
			expect(internals._admitSessionInput(action, { wake: false }).accepted).toBe(true);
		}
		await expect(queueAgent(harness, 20)).rejects.toThrow(capacityError);
		harness.session.dispose();
		pause.release();
	});

	it("restores more than the limit without admitting any further agent actions", async () => {
		const restored = await createHarness();
		harnesses.push(restored);
		const pause = restored.session.acquireQueuedWorkPause();
		for (let batch = 0; batch < 2; batch++) {
			const source = await createHarness();
			harnesses.push(source);
			const sourcePause = source.session.acquireQueuedWorkPause();
			for (let i = 0; i < 20; i++) await queueAgent(source, batch * 20 + i);
			const snapshot = source.session.getSessionActionRecoverySnapshot();
			await expect(restored.session.restoreSessionActions(snapshot)).resolves.toBe(20);
			source.session.dispose();
			sourcePause.release();
		}
		expect(restored.session.unfinishedActionCount).toBe(40);
		await expect(queueAgent(restored, 40)).rejects.toThrow(capacityError);
		const internals = restored.session as unknown as AdmissionInternals;
		for (const ids of [[], [0, 39]]) {
			const action = internals._createPreparedTurnAction("followUp", "ordinary", undefined, {
				prefixMessages: ids.map((id) => agentPrefix(restored, id)),
			});
			expect(internals._admitSessionInput(action, { wake: false }).accepted).toBe(true);
		}
		restored.session.clearQueue();
		expect(restored.session.unfinishedActionCount).toBe(0);
		await expect(queueAgent(restored, 41)).resolves.toBe(true);
		restored.session.dispose();
		pause.release();
	});

	it("preserves parked context when preparation is aborted after concurrent admissions", async () => {
		const hook = gatedHook();
		const harness = await createHarness({ extensionFactories: [hook.factory] });
		harnesses.push(harness);
		const pending = Array.from({ length: 2 }, (_, i) => agentPrefix(harness, i));
		harness.session.restorePendingNextTurnMessages(pending);
		const running = harness.session.prompt("prepare");
		await hook.reached;
		expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual([]);
		// Context is in the asynchronous preparation local, not yet in the action store.
		// Check preservation on abort; strict counting of that in-flight context is a separate gap.
		for (let i = 2; i < 19; i++) await queueAgent(harness, i);
		const internals = harness.session as unknown as AdmissionInternals;
		const oversized = internals._createPreparedTurnAction("followUp", "oversized", undefined, {
			prefixMessages: [19, 20, 21, 22].map((i) => agentPrefix(harness, i)),
		});
		expect(() => internals._admitSessionInput(oversized, { wake: false })).toThrow(capacityError);
		const aborted = harness.session.abort();
		hook.release();
		await aborted;
		await Promise.allSettled([running]);
		expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual(pending);
		harness.session.dispose();
	});

	it("counts an agent action while its model turn is active", async () => {
		const started = createDeferred();
		const release = createDeferred();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("done");
			},
		]);
		const pause = harness.session.acquireQueuedWorkPause();
		await queueAgent(harness, 0);
		pause.release();
		try {
			await started.promise;
			for (let i = 1; i < 20; i++) await queueAgent(harness, i);
			expect(harness.session.unfinishedActionCount).toBe(20);
			await expect(queueAgent(harness, 20)).rejects.toThrow(capacityError);
		} finally {
			harness.session.dispose();
			release.resolve();
		}
	});

	it("counts an active preparing agent action along with queued agents", async () => {
		const hook = gatedHook();
		const harness = await createHarness({ extensionFactories: [hook.factory] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const pause = harness.session.acquireQueuedWorkPause();
		await queueAgent(harness, 0);
		pause.release();
		try {
			await hook.reached;
			for (let i = 1; i < 20; i++) await queueAgent(harness, i);
			expect(harness.session.unfinishedActionCount).toBe(20);
			await expect(queueAgent(harness, 20)).rejects.toThrow(capacityError);
		} finally {
			harness.session.dispose();
			hook.release();
		}
	});
});
