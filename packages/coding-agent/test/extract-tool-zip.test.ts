import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, expect, it } from "vitest";
import { extractToolZip } from "../src/utils/extract-tool-zip.js";

function zip(entries: Array<{ name: string; data?: string; mode?: number; size?: number }>): Buffer {
	const local: Buffer[] = [],
		central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name),
			data = Buffer.from(entry.data ?? ""),
			compressed = deflateRawSync(data);
		let crc = 0xffffffff;
		for (const byte of data) {
			crc ^= byte;
			for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
		crc = (crc ^ 0xffffffff) >>> 0;
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50);
		header.writeUInt16LE(20, 4);
		header.writeUInt16LE(8, 8);
		header.writeUInt32LE(crc, 14);
		header.writeUInt32LE(compressed.length, 18);
		header.writeUInt32LE(entry.size ?? data.length, 22);
		header.writeUInt16LE(name.length, 26);
		local.push(header, name, compressed);
		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014b50);
		directory.writeUInt16LE(0x0314, 4);
		directory.writeUInt16LE(20, 6);
		directory.writeUInt16LE(8, 10);
		directory.writeUInt32LE(crc, 16);
		directory.writeUInt32LE(compressed.length, 20);
		directory.writeUInt32LE(entry.size ?? data.length, 24);
		directory.writeUInt16LE(name.length, 28);
		directory.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
		directory.writeUInt32LE(offset, 42);
		central.push(directory, name);
		offset += header.length + name.length + compressed.length;
	}
	const bytes = Buffer.concat(central),
		end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(bytes.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, bytes, end]);
}
let root: string, staging: string, archive: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "tool-zip-"));
	staging = join(root, "staging");
	mkdirSync(staging);
	archive = join(root, "asset.zip");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it.each(["fd-v10/fd.exe", "rg.exe"])("extracts a regular official-style layout %s", async (name) => {
	writeFileSync(archive, zip([{ name, data: "actual fixture binary bytes" }]));
	await extractToolZip(archive, staging);
	expect(readFileSync(join(staging, name), "utf8")).toBe("actual fixture binary bytes");
});
it.each(
	[
		[{ name: "../escape" }],
		[{ name: "link", mode: 0o120777, data: "../outside" }],
		[{ name: "A.exe" }, { name: "a.exe" }],
		[{ name: "file" }, { name: "file/child" }],
		[{ name: "C:/escape" }],
		[{ name: "file:stream" }],
		[{ name: "nul.txt" }],
		[{ name: "tail. " }],
		[{ name: "special", mode: 0o020600 }],
		[{ name: "large", size: 64 * 1024 * 1024 + 1 }],
	].map((entries) => ({ entries })),
)("rejects invalid later metadata before publishing any valid earlier member %#", async ({ entries: invalid }) => {
	writeFileSync(archive, zip([{ name: "valid-first.exe", data: "must not be written" }, ...invalid]));
	await expect(extractToolZip(archive, staging)).rejects.toThrow();
	expect(readdirSync(staging)).toEqual([]);
});
it("rejects member-count and archive-size excess before extraction", async () => {
	writeFileSync(archive, zip(Array.from({ length: 257 }, (_, i) => ({ name: `file-${i}` }))));
	await expect(extractToolZip(archive, staging)).rejects.toThrow();
	expect(readdirSync(staging)).toEqual([]);
	writeFileSync(archive, Buffer.alloc(16 * 1024 * 1024 + 1));
	await expect(extractToolZip(archive, staging)).rejects.toThrow();
	expect(readdirSync(staging)).toEqual([]);
});
