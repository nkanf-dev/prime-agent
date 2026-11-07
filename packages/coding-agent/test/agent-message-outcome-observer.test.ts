import { describe, expect, it, vi } from "vitest";
import { createHarness } from "./suite/harness.js";
import { createDeferred } from "./suite/scheduling.js";

type Leg = "delivery" | "completion";
type Outcome = {
	delivery?: unknown;
	completion?: unknown;
	deliveryListeners?: Set<unknown>;
	completionListeners?: Set<unknown>;
};
type Internals = {
	_agentMessageOutcomes: Map<string, Outcome>;
	_settleAgentMessage(id: string, leg: Leg, error?: Error): void;
	_disposeAsyncOnce(snapshot: boolean): Promise<void>;
};

describe("AgentSession agent-message outcome observers", () => {
	it.each(["delivery", "completion"] as const)("unsubscription preserves the external %s promise", async (leg) => {
		const live = await createHarness();
		try {
			const session = live.session;
			const internal = session as unknown as Internals;
			const id = `external-${leg}`;
			const wait =
				leg === "delivery"
					? session.waitForAgentMessagePromptDelivery.bind(session)
					: session.waitForAgentMessagePromptCompletion.bind(session);
			const external = wait(id);
			const callback = vi.fn();
			const stop = session.observeAgentMessagePromptOutcome(id, callback);
			stop();
			expect(wait(id)).toBe(external);
			expect(internal._agentMessageOutcomes.get(id)?.[`${leg}Listeners`]?.size ?? 0).toBe(0);
			internal._settleAgentMessage(id, leg);
			await expect(external).resolves.toBeUndefined();
			await Promise.resolve();
			expect(callback).not.toHaveBeenCalled();
			expect(internal._agentMessageOutcomes.has(id)).toBe(false);
		} finally {
			live.cleanup();
		}
	});

	it("same listener registered twice has independent unsubscribe and receives both legs", async () => {
		const live = await createHarness();
		try {
			const internal = live.session as unknown as Internals;
			const listener = vi.fn();
			const first = live.session.observeAgentMessagePromptOutcome("duplicate", listener);
			const second = live.session.observeAgentMessagePromptOutcome("duplicate", listener);
			first();
			first();
			expect(internal._agentMessageOutcomes.get("duplicate")?.deliveryListeners?.size).toBe(1);
			expect(internal._agentMessageOutcomes.get("duplicate")?.completionListeners?.size).toBe(1);
			internal._settleAgentMessage("duplicate", "delivery");
			internal._settleAgentMessage("duplicate", "completion");
			await Promise.resolve();
			expect(listener.mock.calls).toEqual([
				["delivery", undefined],
				["completion", undefined],
			]);
			second();
			expect(internal._agentMessageOutcomes.size).toBe(0);
		} finally {
			live.cleanup();
		}
	});

	it.each(["delivery", "completion"] as const)("unsubscribe suppresses an already queued %s callback", async (leg) => {
		const live = await createHarness();
		try {
			const internal = live.session as unknown as Internals;
			const callback = vi.fn();
			const stop = live.session.observeAgentMessagePromptOutcome("queued", callback);
			internal._settleAgentMessage("queued", leg);
			stop();
			await Promise.resolve();
			expect(callback).not.toHaveBeenCalled();
			expect(internal._agentMessageOutcomes.size).toBe(0);
		} finally {
			live.cleanup();
		}
	});

	it.each(["delivery", "completion"] as const)(
		"isolates a throwing %s observer from other observers and waiters",
		async (leg) => {
			const live = await createHarness();
			try {
				const session = live.session;
				const internal = session as unknown as Internals;
				const thrown = vi.fn(() => {
					throw new Error("observer failed");
				});
				const other = vi.fn();
				const stop1 = session.observeAgentMessagePromptOutcome("throw", thrown);
				const stop2 = session.observeAgentMessagePromptOutcome("throw", other);
				const wait =
					leg === "delivery"
						? session.waitForAgentMessagePromptDelivery("throw")
						: session.waitForAgentMessagePromptCompletion("throw");
				const failure = new Error("terminal");
				const result = wait.catch((error) => error);
				internal._settleAgentMessage("throw", leg, failure);
				expect(await result).toBe(failure);
				await Promise.resolve();
				expect(thrown).toHaveBeenCalledOnce();
				expect(other).toHaveBeenCalledExactlyOnceWith(leg, failure);
				stop1();
				stop2();
				expect(internal._agentMessageOutcomes.size).toBe(0);
			} finally {
				live.cleanup();
			}
		},
	);

	it("after disposal a listener receives both leg errors, and can suppress them", async () => {
		const live = await createHarness();
		try {
			const internal = live.session as unknown as Internals;
			live.session.dispose();
			const late = vi.fn();
			const suppressed = vi.fn();
			live.session.observeAgentMessagePromptOutcome("disposed", late);
			const stop = live.session.observeAgentMessagePromptOutcome("disposed-stop", suppressed);
			stop();
			await Promise.resolve();
			expect(late.mock.calls.map(([leg]) => leg)).toEqual(["delivery", "completion"]);
			for (const [, error] of late.mock.calls) expect(error).toBeInstanceOf(Error);
			expect(suppressed).not.toHaveBeenCalled();
			expect(internal._agentMessageOutcomes.size).toBe(0);
		} finally {
			live.cleanup();
		}
	});

	it("rejects registration while async disposal is in progress without retaining it", async () => {
		const live = await createHarness();
		const entered = createDeferred();
		const release = createDeferred();
		const internal = live.session as unknown as Internals;
		const spy = vi.spyOn(internal, "_disposeAsyncOnce").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
		});
		let disposing: Promise<void> | undefined;
		try {
			disposing = live.session.disposeAsync({ kernelSnapshot: false });
			await entered.promise;
			const rejected = vi.fn();
			live.session.observeAgentMessagePromptOutcome("disposing", rejected);
			const suppressed = vi.fn();
			const stop = live.session.observeAgentMessagePromptOutcome("disposing-stop", suppressed);
			stop();
			await Promise.resolve();
			expect(rejected.mock.calls.map(([leg]) => leg)).toEqual(["delivery", "completion"]);
			for (const [, error] of rejected.mock.calls) expect(error).toBeInstanceOf(Error);
			expect(suppressed).not.toHaveBeenCalled();
			expect(internal._agentMessageOutcomes.size).toBe(0);
		} finally {
			release.resolve();
			if (disposing) await disposing;
			spy.mockRestore();
			live.cleanup();
		}
	});
});
