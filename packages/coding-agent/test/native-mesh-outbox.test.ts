import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeMeshOutbox } from "../src/modes/daemon/native-mesh/outbox.js";
import {
	NativeMeshTransport,
	nativeMeshAgentId,
	nativeMeshRequestId,
} from "../src/modes/daemon/native-mesh/transport.js";

const directories: string[] = [];
function directory(): string {
	const dir = mkdtempSync(join(tmpdir(), "native-outbox-"));
	directories.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const from = nativeMeshAgentId("host-a", "one");
const to = nativeMeshAgentId("host-b", "two");

describe("native mesh durable outbox", () => {
	it("retains uncertain stores, survives restart, and retries the same identity", async () => {
		const dir = directory();
		const store = vi
			.fn()
			.mockRejectedValueOnce(new Error("network timeout"))
			.mockImplementation(async (item) => ({
				requestId: nativeMeshRequestId(item.from, item.callerMessageId),
				deliveryStatus: "stored" as const,
			}));
		const first = new NativeMeshOutbox(dir, { store });
		const id = first.enqueue({ from, to, text: "hello", callerMessageId: "same-id" });
		await expect(first.send(id)).rejects.toThrow("network timeout");
		expect(first.pending()).toEqual([id]);
		const second = new NativeMeshOutbox(dir, { store });
		expect(second.read(id)).toMatchObject({ from, to, callerMessageId: "same-id", text: "hello" });
		await second.send(id);
		expect(second.pending()).toEqual([]);
		expect(store.mock.calls[0]![0]).toEqual(store.mock.calls[1]![0]);
	});
	it("retries one stored request after a real HTTP connection drops its first response", async () => {
		const saved = new Map<string, Record<string, unknown>>();
		let drop = true;
		const server = createServer(async (req, res) => {
			let body = "";
			for await (const chunk of req) body += chunk;
			const parsed = JSON.parse(body);
			const message = saved.get(parsed.requestId) ?? {
				...parsed,
				createdAt: new Date().toISOString(),
				acknowledgedAt: null,
			};
			saved.set(parsed.requestId, message);
			if (drop) {
				drop = false;
				req.socket.destroy();
				return;
			}
			res.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({ status: "accepted", message }),
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
			const transport = new NativeMeshTransport({ url, token: "test-only" });
			const dir = directory();
			const first = new NativeMeshOutbox(dir, transport);
			const id = first.enqueue({ from, to, text: "one HTTP message" });
			await expect(first.send(id)).rejects.toMatchObject({ outcome: "unknown" });
			expect(first.pending()).toEqual([id]);
			expect(saved.size).toBe(1);
			const restarted = new NativeMeshOutbox(dir, transport);
			await restarted.send(id);
			expect(saved.size).toBe(1);
			expect(restarted.pending()).toEqual([]);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
	it("deduplicates enqueues and concurrent sends but rejects conflicting reuse", async () => {
		let release!: () => void;
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const store = vi.fn(async (item) => {
			await wait;
			return { requestId: nativeMeshRequestId(item.from, item.callerMessageId), deliveryStatus: "stored" as const };
		});
		const box = new NativeMeshOutbox(directory(), { store });
		const input = { from, to, text: "hello", callerMessageId: "stable" };
		const id = box.enqueue(input);
		expect(box.enqueue(input)).toBe(id);
		expect(() => box.enqueue({ ...input, text: "different" })).toThrow("Conflicting");
		const one = box.send(id);
		const two = box.send(id);
		release();
		await Promise.all([one, two]);
		expect(store).toHaveBeenCalledTimes(1);
	});
	it("refuses tampered on-disk identity without sending or deleting", async () => {
		const dir = directory();
		const store = vi.fn();
		const box = new NativeMeshOutbox(dir, { store });
		const id = box.enqueue({ from, to, text: "hello" });
		const path = join(dir, `${id}.json`);
		const item = JSON.parse(readFileSync(path, "utf8"));
		item.callerMessageId = "tampered";
		writeFileSync(path, JSON.stringify(item));
		await expect(box.send(id)).rejects.toThrow("identity mismatch");
		expect(box.pending()).toEqual([id]);
		expect(store).not.toHaveBeenCalled();
	});
});
