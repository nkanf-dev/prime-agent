import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type NativeMeshEndpoint, NativeMeshEndpoints } from "../src/modes/daemon/native-mesh/endpoints.js";

const dirs: string[] = [];
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "native-endpoints-"));
	dirs.push(dir);
	return { dir, registry: new NativeMeshEndpoints(join(dir, "registry")) };
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function endpoint(dir: string, overrides: Partial<NativeMeshEndpoint> = {}): NativeMeshEndpoint {
	return {
		machineId: "machine-a",
		sessionId: "child",
		sessionPath: join(dir, "child.jsonl"),
		rootPath: join(dir, "root.jsonl"),
		rootSessionId: "root",
		ancestors: [
			{ sessionId: "parent", sessionPath: join(dir, "parent.jsonl") },
			{ sessionId: "root", sessionPath: join(dir, "root.jsonl") },
		],
		name: "child agent",
		cwd: dir,
		rlmDepth: 2,
		...overrides,
	};
}

describe("NativeMeshEndpoints", () => {
	it("persists complete bindings across restart and updates metadata", () => {
		const { dir, registry } = setup();
		const item = endpoint(dir);
		registry.upsert(item);
		const restarted = new NativeMeshEndpoints(join(dir, "registry"));
		expect(restarted.read("machine-a", "child")).toEqual(item);
		expect(restarted.list("machine-a")).toEqual([item]);
		const updated = { ...item, name: "new name", cwd: join(dir, "work") };
		restarted.upsert(updated);
		expect(new NativeMeshEndpoints(join(dir, "registry")).read("machine-a", "child")).toEqual(updated);
		if (process.platform !== "win32")
			expect(statSync(join(dir, "registry", "endpoints.json")).mode & 0o777).toBe(0o600);
	});

	it("partitions exact machine and session IDs and removes only the selected binding", () => {
		const { dir, registry } = setup();
		const a = endpoint(dir),
			b = endpoint(dir, { machineId: "machine-b", sessionPath: join(dir, "other") });
		registry.upsert(a);
		registry.upsert(b);
		expect(registry.read("machine-A", "child")).toBeUndefined();
		expect(registry.read("machine-a", "chil")).toBeUndefined();
		expect(registry.list("machine-b")).toEqual([b]);
		expect(registry.remove("machine-a", "child")).toBe(true);
		expect(registry.remove("machine-a", "child")).toBe(false);
		expect(new NativeMeshEndpoints(join(dir, "registry")).list("machine-b")).toEqual([b]);
	});

	it("canonicalizes aliases but rejects a different path for the same identity", () => {
		const { dir, registry } = setup();
		const original = endpoint(dir);
		writeFileSync(original.sessionPath, "session");
		const alias = join(dir, "alias");
		symlinkSync(original.sessionPath, alias);
		registry.upsert(original);
		registry.upsert({ ...original, sessionPath: alias });
		expect(registry.read("machine-a", "child")?.sessionPath).toBe(original.sessionPath);
		expect(() => registry.upsert({ ...original, sessionPath: join(dir, "different") })).toThrow(/Conflicting/);
		expect(registry.read("machine-a", "child")).toBeUndefined();
		expect(registry.list("machine-a")).toEqual([]);
		const restarted = new NativeMeshEndpoints(join(dir, "registry"));
		expect(restarted.read("machine-a", "child")).toBeUndefined();
		expect(() => restarted.upsert(original)).toThrow(/Quarantined/);
		expect(() => restarted.upsert({ ...original, sessionPath: join(dir, "different") })).toThrow(/Quarantined/);
		expect(restarted.remove("machine-a", "child")).toBe(true);
		restarted.upsert({ ...original, sessionPath: join(dir, "different") });
		expect(new NativeMeshEndpoints(join(dir, "registry")).read("machine-a", "child")?.sessionPath).toBe(
			join(dir, "different"),
		);
	});

	it("fails closed on malformed data or duplicate keys at construction", () => {
		const { dir } = setup();
		const path = join(dir, "registry", "endpoints.json");
		writeFileSync(path, "not json");
		expect(() => new NativeMeshEndpoints(join(dir, "registry"))).toThrow();
		const item = endpoint(dir);
		writeFileSync(
			path,
			JSON.stringify({ version: 1, endpoints: [item, { ...item, sessionPath: join(dir, "different") }] }),
		);
		expect(() => new NativeMeshEndpoints(join(dir, "registry"))).toThrow(/Duplicate/);
		writeFileSync(path, JSON.stringify({ version: 2, endpoints: [] }));
		expect(() => new NativeMeshEndpoints(join(dir, "registry"))).toThrow(/Invalid/);
	});

	it("rejects invalid ancestry, accepts roots, and preserves the prior record", () => {
		const { dir, registry } = setup();
		const item = endpoint(dir);
		registry.upsert(item);
		expect(() => registry.read("", "child")).toThrow();
		expect(() => registry.upsert({ ...item, rlmDepth: 1 })).toThrow();
		expect(() => registry.upsert({ ...item, rootPath: "" })).toThrow();
		expect(() => registry.upsert({ ...item, ancestors: [item.ancestors[0], item.ancestors[0]] })).toThrow();
		expect(() => registry.upsert({ ...item, rootSessionId: "wrong" })).toThrow();
		expect(registry.list("machine-a")).toEqual([item]);
		const root = endpoint(dir, { sessionId: "root", sessionPath: item.rootPath, ancestors: [], rlmDepth: 0 });
		registry.upsert(root);
		expect(registry.read("machine-a", "root")).toEqual(root);
	});

	it("returns snapshots and does not replace the file on identical upsert", () => {
		const { dir, registry } = setup();
		const item = endpoint(dir);
		registry.upsert(item);
		const path = join(dir, "registry", "endpoints.json");
		const inode = statSync(path).ino;
		registry.upsert(endpoint(dir));
		expect(statSync(path).ino).toBe(inode);
		const result = registry.read("machine-a", "child")!;
		result.name = "changed";
		result.ancestors[0].sessionId = "changed";
		registry.list("machine-a")[0].ancestors.pop();
		expect(registry.read("machine-a", "child")).toEqual(item);
		item.ancestors[0].sessionId = "caller change";
		expect(registry.read("machine-a", "child")?.ancestors[0].sessionId).toBe("parent");
	});

	it("quarantines a missing key across restart without affecting another machine", () => {
		const { dir, registry } = setup();
		const other = endpoint(dir, { machineId: "other-machine" });
		registry.upsert(other);
		registry.quarantine("machine-a", "child");
		const path = join(dir, "registry", "endpoints.json");
		const inode = statSync(path).ino;
		registry.quarantine("machine-a", "child");
		expect(statSync(path).ino).toBe(inode);
		const restarted = new NativeMeshEndpoints(join(dir, "registry"));
		expect(() => restarted.upsert(endpoint(dir))).toThrow(/Quarantined/);
		expect(restarted.read("other-machine", "child")).toEqual(other);
		expect(restarted.remove("machine-a", "child")).toBe(true);
		restarted.upsert(endpoint(dir));
		expect(restarted.list("machine-a")).toHaveLength(1);
	});

	it("hides a key on failed quarantine and retries persistence", () => {
		const { dir, registry } = setup();
		const item = endpoint(dir);
		registry.upsert(item);
		const path = join(dir, "registry", "endpoints.json");
		rmSync(path);
		mkdirSync(path);
		expect(() => registry.quarantine("machine-a", "child")).toThrow();
		expect(registry.read("machine-a", "child")).toBeUndefined();
		expect(() => registry.quarantine("machine-a", "child")).toThrow();
		rmSync(path, { recursive: true });
		registry.quarantine("machine-a", "child");
		expect(new NativeMeshEndpoints(join(dir, "registry")).read("machine-a", "child")).toBeUndefined();
	});

	it("keeps the previous in-memory state if an atomic replace fails", () => {
		const { dir, registry } = setup();
		const item = endpoint(dir);
		registry.upsert(item);
		const path = join(dir, "registry", "endpoints.json");
		rmSync(path);
		mkdirSync(path);
		expect(() => registry.upsert({ ...item, name: "new" })).toThrow();
		expect(() => registry.remove("machine-a", "child")).toThrow();
		expect(registry.read("machine-a", "child")).toEqual(item);
	});
});
