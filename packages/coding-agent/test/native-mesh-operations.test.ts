import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeMeshOperations } from "../src/modes/daemon/native-mesh/operations.js";
import { NativeMeshOutbox } from "../src/modes/daemon/native-mesh/outbox.js";
import { nativeMeshAgentId, nativeMeshRequestId } from "../src/modes/daemon/native-mesh/transport.js";

vi.mock("node:fs", { spy: true });

const directories: string[] = [];
function directory(): string {
	const dir = mkdtempSync(join(tmpdir(), "native-operations-"));
	directories.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const from = nativeMeshAgentId("host-a", "one");
const to = nativeMeshAgentId("host-b", "two");
const other = nativeMeshAgentId("host-c", "three");
const input = { from, to, text: " exact text \n", operationId: "caller-operation" };

describe("native mesh durable operation bindings", () => {
	it("can publish and recover operation and outbox records with Windows directory sync unavailable", () => {
		const dir = directory();
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		const sync = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
			if (fs.fstatSync(fd).isDirectory())
				throw Object.assign(new Error("directory fsync unsupported"), { code: "EPERM" });
		});
		try {
			Object.defineProperty(process, "platform", { ...platform, value: "win32" });
			const journal = new NativeMeshOperations(join(dir, "operations"));
			const box = new NativeMeshOutbox(join(dir, "outbox"), {
				store: async (item) => ({
					requestId: nativeMeshRequestId(item.from, item.callerMessageId),
					deliveryStatus: "stored",
				}),
			});
			const id = journal.bind(input);
			expect(box.enqueue({ from, to, text: input.text, callerMessageId: input.operationId })).toBe(id);
			expect(new NativeMeshOperations(join(dir, "operations")).get(from, input.operationId)).toEqual({
				version: 1,
				...input,
			});
			expect(
				new NativeMeshOutbox(join(dir, "outbox"), {
					store: async () => {
						throw new Error("not called");
					},
				}).pending(),
			).toEqual([id]);
			journal.markStored(id);
			expect(journal.pending()).toEqual([]);
			expect(sync.mock.calls.length).toBeGreaterThanOrEqual(3);
		} finally {
			sync.mockRestore();
			Object.defineProperty(process, "platform", platform);
		}
	});

	it("propagates directory fsync failures on Unix", () => {
		const dir = directory();
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		const sync = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
			if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
		});
		try {
			Object.defineProperty(process, "platform", { ...platform, value: "linux" });
			expect(() => new NativeMeshOperations(join(dir, "operations"))).toThrow("directory sync failed");
			expect(
				() =>
					new NativeMeshOutbox(join(dir, "outbox"), {
						store: async () => {
							throw new Error("not called");
						},
					}),
			).toThrow("directory sync failed");
		} finally {
			sync.mockRestore();
			Object.defineProperty(process, "platform", platform);
		}
	});
	it("binds duplicate calls and preserves exact payload across restarts", () => {
		const dir = join(directory(), "nested", "operations");
		const first = new NativeMeshOperations(dir);
		expect(first.get(from, input.operationId)).toBeUndefined();
		const id = first.bind(input);
		expect(id).toBe(nativeMeshRequestId(from, input.operationId));
		expect(first.bind({ ...input })).toBe(id);
		const restarted = new NativeMeshOperations(dir);
		expect(restarted.get(from, input.operationId)).toEqual({ version: 1, ...input });
		expect(restarted.bind(input)).toBe(id);
		expect(restarted.read(id)).toEqual({ version: 1, ...input });
	});
	it("rejects changed recipient or text without modifying the existing binding", () => {
		const dir = directory();
		const journal = new NativeMeshOperations(dir);
		const id = journal.bind(input);
		const before = readFileSync(join(dir, `${id}.json`), "utf8");
		const restarted = new NativeMeshOperations(dir);
		expect(() => restarted.bind({ ...input, to: other })).toThrow("Conflicting");
		expect(() => restarted.bind({ ...input, text: "different" })).toThrow("Conflicting");
		expect(readFileSync(join(dir, `${id}.json`), "utf8")).toBe(before);
		expect(restarted.get(from, input.operationId)).toEqual({ version: 1, ...input });
		expect(restarted.bind({ ...input, operationId: "another" })).not.toBe(id);
	});
	it("retains the binding after the outbox removes a delivered item", async () => {
		const dir = directory();
		const journal = new NativeMeshOperations(join(dir, "operations"));
		const outbox = new NativeMeshOutbox(join(dir, "outbox"), {
			store: async (item) => ({
				requestId: nativeMeshRequestId(item.from, item.callerMessageId),
				deliveryStatus: "stored" as const,
			}),
		});
		const id = journal.bind(input);
		expect(outbox.enqueue({ from, to, text: input.text, callerMessageId: input.operationId })).toBe(id);
		await outbox.send(id);
		expect(outbox.pending()).toEqual([]);
		const restarted = new NativeMeshOperations(join(dir, "operations"));
		expect(restarted.get(from, input.operationId)).toEqual({ version: 1, ...input });
		expect(() => restarted.bind({ ...input, text: "different" })).toThrow("Conflicting");
	});
	it("recovers pending bindings after restart and persists stored markers", () => {
		const dir = directory();
		const first = new NativeMeshOperations(dir);
		const id = first.bind(input);
		const otherId = first.bind({ ...input, operationId: "second" });
		expect(first.pending()).toEqual([id, otherId].sort());
		const restarted = new NativeMeshOperations(dir);
		expect(restarted.pending()).toEqual([id, otherId].sort());
		restarted.markStored(id);
		restarted.markStored(id);
		expect(restarted.pending()).toEqual([otherId]);
		const again = new NativeMeshOperations(dir);
		expect(again.pending()).toEqual([otherId]);
		expect(again.get(from, input.operationId)).toEqual({ version: 1, ...input });
		expect(again.bind(input)).toBe(id);
		expect(again.pending()).toEqual([otherId]);
		expect(() => again.markStored(nativeMeshRequestId(from, "unknown"))).toThrow();
	});
	it("fails closed on a corrupt stored marker", () => {
		const dir = directory();
		const journal = new NativeMeshOperations(dir);
		const id = journal.bind(input);
		journal.markStored(id);
		writeFileSync(join(dir, `${id}.stored`), "invalid");
		expect(() => journal.pending()).toThrow("Invalid native mesh stored marker");
		expect(() => journal.markStored(id)).toThrow("Invalid native mesh stored marker");
	});
	it("fails closed on corrupt or invalid bindings", () => {
		const dir = directory();
		const journal = new NativeMeshOperations(dir);
		const id = journal.bind(input);
		writeFileSync(join(dir, `${id}.json`), JSON.stringify({ version: 1, ...input, operationId: "tampered" }));
		expect(() => journal.get(from, input.operationId)).toThrow("identity mismatch");
		expect(() => journal.bind(input)).toThrow("identity mismatch");
		expect(() => journal.read("../bad")).toThrow("Invalid");
		expect(() => journal.bind({ ...input, text: "" })).toThrow("Invalid");
		expect(() => journal.bind({ ...input, operationId: "bad\nname" })).toThrow("Invalid");
	});
});
