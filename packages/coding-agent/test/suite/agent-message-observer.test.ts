import { describe, expect, it, vi } from "vitest";
import { createHarness } from "./harness.js";

type OutcomeInternals = {
	_agentMessageOutcomes: Map<string, unknown>;
	_settleAgentMessage(id: string, leg: "delivery" | "completion", error?: Error): void;
};

describe("agent message outcome observers", () => {
	it("detaches only its own listener without cancelling shared promise consumers", async () => {
		const h = await createHarness();
		try {
			const internal = h.session as unknown as OutcomeInternals;
			const id = "observer-external";
			const delivery = h.session.waitForAgentMessagePromptDelivery(id);
			const completion = h.session.waitForAgentMessagePromptCompletion(id);
			const called = vi.fn();
			const stop = h.session.observeAgentMessagePromptOutcome(id, called);
			stop();
			internal._settleAgentMessage(id, "delivery");
			internal._settleAgentMessage(id, "completion");
			await Promise.all([delivery, completion]);
			expect(called).not.toHaveBeenCalled();
			expect(internal._agentMessageOutcomes.has(id)).toBe(false);
		} finally {
			h.cleanup();
		}
	});

	it("suppresses already queued callbacks on unsubscribe and isolates thrown callbacks", async () => {
		const h = await createHarness();
		try {
			const internal = h.session as unknown as OutcomeInternals;
			const id = "observer-queued";
			const cancelled = vi.fn();
			const survivor = vi.fn();
			const stop = h.session.observeAgentMessagePromptOutcome(id, cancelled);
			const stopThrowing = h.session.observeAgentMessagePromptOutcome(id, () => {
				throw new Error("listener failure");
			});
			const stopSurvivor = h.session.observeAgentMessagePromptOutcome(id, survivor);
			internal._settleAgentMessage(id, "delivery");
			stop();
			await Promise.resolve();
			expect(cancelled).not.toHaveBeenCalled();
			expect(survivor).toHaveBeenCalledWith("delivery", undefined);
			stopThrowing();
			stopSurvivor();
			expect(internal._agentMessageOutcomes.has(id)).toBe(false);
		} finally {
			h.cleanup();
		}
	});

	it("retires a listener-only outcome after a terminal completion", async () => {
		const h = await createHarness();
		try {
			const internal = h.session as unknown as OutcomeInternals;
			const id = "observer-completion";
			const listener = vi.fn();
			const stop = h.session.observeAgentMessagePromptOutcome(id, listener);
			internal._settleAgentMessage(id, "completion");
			await Promise.resolve();
			expect(listener).toHaveBeenCalledWith("completion", undefined);
			stop();
			expect(internal._agentMessageOutcomes.has(id)).toBe(false);
		} finally {
			h.cleanup();
		}
	});

	it("drains listener-only outcomes at dispose and refuses reentrant registration", async () => {
		const h = await createHarness();
		try {
			const internal = h.session as unknown as OutcomeInternals;
			const reentrant = vi.fn();
			const first = vi.fn(() => h.session.observeAgentMessagePromptOutcome("after-dispose", reentrant));
			h.session.observeAgentMessagePromptOutcome("before-dispose", first);
			h.session.dispose();
			await Promise.resolve();
			await Promise.resolve();
			expect(first).toHaveBeenCalled();
			expect(reentrant).toHaveBeenCalledWith("delivery", expect.any(Error));
			expect(internal._agentMessageOutcomes.size).toBe(0);
		} finally {
			h.cleanup();
		}
	});
});
