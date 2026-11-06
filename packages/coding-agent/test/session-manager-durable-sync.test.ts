import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	fsync: vi.fn<typeof import("node:fs").fsyncSync>(),
	open: vi.fn<typeof import("node:fs").openSync>(),
	actualFsync: undefined as typeof import("node:fs").fsyncSync | undefined,
}));
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	mocks.actualFsync = actual.fsyncSync;
	mocks.fsync.mockImplementation(actual.fsyncSync);
	mocks.open.mockImplementation(actual.openSync);
	return { ...actual, fsyncSync: mocks.fsync, openSync: mocks.open };
});

import { SessionManager } from "../src/core/session-manager.js";

const dirs: string[] = [];
afterEach(() => {
	mocks.fsync.mockReset();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function create() {
	const dir = mkdtempSync(join(tmpdir(), "pi-durable-sync-"));
	dirs.push(dir);
	const manager = SessionManager.create(dir, join(dir, "sessions"));
	const entryId = manager.appendCustomEntry("mesh-test", { data: "hello" });
	manager.flushNow();
	return { manager, entryId, file: manager.getSessionFile()! };
}

describe("SessionManager.syncPersistedEntry", () => {
	it("syncs the file then every canonical parent directory through the root", async () => {
		const actual = await import("node:fs");
		const { manager, entryId, file } = create();
		const synced: string[] = [];
		const expected = [file];
		let directory = actual.realpathSync(dirname(file));
		for (;;) {
			expected.push(directory);
			const parent = dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
		mocks.fsync.mockImplementation((fd) => {
			const st = actual.fstatSync(fd);
			const path = expected.find((candidate) => {
				const candidateStat = actual.statSync(candidate);
				return st.dev === candidateStat.dev && st.ino === candidateStat.ino;
			});
			synced.push(path ?? "unknown");
			mocks.actualFsync!(fd);
		});
		mocks.fsync.mockClear();
		manager.syncPersistedEntry(entryId);
		expect(synced).toEqual(expected);
	});
	it("syncs and validates the session file without directory handles on Windows", async () => {
		const actual = await import("node:fs");
		const { manager, entryId, file } = create();
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		const synced: string[] = [];
		mocks.fsync.mockImplementation((fd) => {
			const stat = actual.fstatSync(fd);
			synced.push(stat.isFile() ? "file" : "directory");
			mocks.actualFsync!(fd);
		});
		try {
			Object.defineProperty(process, "platform", { ...platform, value: "win32" });
			mocks.open.mockClear();
			manager.syncPersistedEntry(entryId);
			expect(synced).toEqual(["file"]);
			expect(mocks.open).toHaveBeenCalledWith(file, actual.constants.O_RDWR);
			writeFileSync(file, readFileSync(file, "utf8").replace("hello", "world"));
			expect(() => manager.syncPersistedEntry(entryId)).toThrow();
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
	});

	it("rejects a replaced file during Windows sync", () => {
		const { manager, entryId, file } = create();
		const replacement = `${file}.replacement`;
		copyFileSync(file, replacement);
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		mocks.fsync.mockImplementationOnce((fd) => {
			mocks.actualFsync!(fd);
			renameSync(replacement, file);
		});
		try {
			Object.defineProperty(process, "platform", { ...platform, value: "win32" });
			expect(() => manager.syncPersistedEntry(entryId)).toThrow();
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
	});

	it("rejects missing and buffered entries", () => {
		const manager = SessionManager.inMemory("/tmp");
		const id = manager.appendCustomEntry("buffered");
		expect(() => manager.syncPersistedEntry(id)).toThrow(/not persisted/);
		const dir = mkdtempSync(join(tmpdir(), "pi-durable-sync-"));
		dirs.push(dir);
		const disk = SessionManager.create(dir, join(dir, "sessions"));
		const pending = disk.appendCustomEntry("pending");
		expect(() => disk.syncPersistedEntry(pending)).toThrow(/not persisted/);
		expect(() => disk.syncPersistedEntry("missing")).toThrow(/not persisted/);
	});
	it.each([0, 1, 2, 3])("propagates fsync failure at call %i", (failureIndex) => {
		const { manager, entryId } = create();
		let calls = 0;
		mocks.fsync.mockImplementation((fd) => {
			if (calls++ === failureIndex) throw new Error("injected fsync failure");
			mocks.actualFsync!(fd);
		});
		expect(() => manager.syncPersistedEntry(entryId)).toThrow("injected fsync failure");
	});
	it("rejects replacement between file and directory sync", () => {
		const { manager, entryId, file } = create();
		const replacement = `${file}.replacement`;
		copyFileSync(file, replacement);
		mocks.fsync.mockImplementationOnce((fd) => {
			mocks.actualFsync!(fd);
			renameSync(replacement, file);
		});
		expect(() => manager.syncPersistedEntry(entryId)).toThrow(/changed during sync/);
	});
	it("supports symlinked directory ancestors and detects a symlink swap", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-durable-link-"));
		dirs.push(dir);
		const target = join(dir, "target");
		const other = join(dir, "other");
		const alias = join(dir, "alias");
		mkdirSync(target);
		mkdirSync(other);
		symlinkSync(target, alias);
		const manager = SessionManager.create(dir, join(alias, "sessions"));
		const id = manager.appendCustomEntry("mesh-test");
		manager.flushNow();
		manager.syncPersistedEntry(id);
		mkdirSync(join(other, "sessions"));
		const file = manager.getSessionFile()!;
		copyFileSync(file, join(other, "sessions", basename(file)));
		mocks.fsync.mockImplementationOnce((fd) => {
			mocks.actualFsync!(fd);
			unlinkSync(alias);
			symlinkSync(other, alias);
		});
		expect(() => manager.syncPersistedEntry(id)).toThrow();
	});
	it("rejects a replaced containing directory during sync", () => {
		const { manager, entryId, file } = create();
		const directory = dirname(file);
		mocks.fsync.mockImplementationOnce((fd) => {
			mocks.actualFsync!(fd);
			renameSync(directory, `${directory}.old`);
			mkdirSync(directory);
			copyFileSync(join(`${directory}.old`, basename(file)), file);
		});
		expect(() => manager.syncPersistedEntry(entryId)).toThrow(/changed during sync/);
	});

	it("rejects an entry whose in-memory content no longer matches the file", () => {
		const { manager, entryId } = create();
		const entry = manager.getEntry(entryId);
		if (!entry || entry.type !== "custom") throw new Error("expected custom entry");
		entry.data = { data: "changed" };
		expect(() => manager.syncPersistedEntry(entryId)).toThrow(/does not match/);
	});
	it("rejects changed contents and symlink replacement", () => {
		const { manager, entryId, file } = create();
		writeFileSync(file, readFileSync(file, "utf8").replace("hello", "world"));
		expect(() => manager.syncPersistedEntry(entryId)).toThrow();
		const target = `${file}.target`;
		renameSync(file, target);
		symlinkSync(target, file);
		expect(() => manager.syncPersistedEntry(entryId)).toThrow();
	});
});
