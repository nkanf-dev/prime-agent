/** Small fd/rg ZIP assets only. Validate every destination before writing any entry. */
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type Entry, open, type ZipFile } from "yauzl";

// Official fd/rg Windows archives measured <=1.8 MiB compressed, 4.7 MiB expanded, 16 entries.
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 256;
interface ToolEntry {
	entry: Entry;
	path: string;
	directory: boolean;
}

function destination(entry: Entry): ToolEntry {
	const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
	const directory = mode === 0o040000 || entry.fileName.endsWith("/") || entry.externalFileAttributes === 16;
	if (
		(mode !== 0 && mode !== 0o100000 && mode !== 0o040000) ||
		entry.isEncrypted() ||
		![0, 8].includes(entry.compressionMethod) ||
		!Number.isSafeInteger(entry.uncompressedSize) ||
		entry.uncompressedSize < 0 ||
		entry.uncompressedSize > MAX_EXPANDED_BYTES ||
		(directory && entry.uncompressedSize !== 0)
	)
		throw new Error("Tool ZIP contains an unsupported entry");
	const path = directory && entry.fileName.endsWith("/") ? entry.fileName.slice(0, -1) : entry.fileName;
	if (
		!path ||
		isAbsolute(path) ||
		/[\\:*?"<>|\x00-\x1f\x7f]/.test(path) ||
		path
			.split("/")
			.some(
				(part) =>
					!part ||
					part === "." ||
					part === ".." ||
					/[. ]$/.test(part) ||
					/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
			)
	)
		throw new Error("Tool ZIP contains an unsafe destination");
	return { entry, path, directory };
}

async function validatedEntries(zip: ZipFile): Promise<ToolEntry[]> {
	const entries: ToolEntry[] = [];
	await new Promise<void>((resolve, reject) => {
		let total = 0;
		zip.once("error", reject);
		zip.once("end", resolve);
		zip.on("entry", (entry: Entry) => {
			try {
				if (entries.length === MAX_ENTRIES) throw new Error("Tool ZIP has too many entries");
				const item = destination(entry);
				total += entry.uncompressedSize;
				if (total > MAX_EXPANDED_BYTES) throw new Error("Tool ZIP exceeds the expanded size limit");
				entries.push(item);
				zip.readEntry();
			} catch (error) {
				reject(error);
			}
		});
		zip.readEntry();
	});
	const destinations = new Map<string, ToolEntry>();
	for (const item of entries) {
		const key = item.path.toLowerCase();
		if (destinations.has(key)) throw new Error("Tool ZIP has duplicate or case-aliased destinations");
		destinations.set(key, item);
	}
	for (const item of entries) {
		const parts = item.path.toLowerCase().split("/");
		parts.pop();
		while (parts.length) {
			const ancestor = destinations.get(parts.join("/"));
			if (ancestor && !ancestor.directory) throw new Error("Tool ZIP has a file/directory collision");
			parts.pop();
		}
	}
	return entries;
}

export async function extractToolZip(archivePath: string, directory: string): Promise<void> {
	if (
		!isAbsolute(directory) ||
		!(await lstat(directory)).isDirectory() ||
		(await lstat(directory)).isSymbolicLink() ||
		(await readdir(directory)).length
	)
		throw new Error("Tool ZIP needs a new empty staging directory");
	if ((await stat(archivePath)).size > MAX_ARCHIVE_BYTES) throw new Error("Tool ZIP exceeds the archive size limit");
	const zip = await new Promise<ZipFile>((resolve, reject) => {
		open(
			archivePath,
			{ lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true },
			(error, file) => {
				if (error) reject(error);
				else resolve(file);
			},
		);
	});
	try {
		const entries = await validatedEntries(zip);
		const root = await realpath(directory);
		for (const item of entries) {
			const target = join(root, ...item.path.split("/"));
			const rel = relative(root, target);
			if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
				throw new Error("Tool ZIP destination leaves staging");
			if (item.directory) {
				await mkdir(target, { recursive: true, mode: 0o700 });
				continue;
			}
			await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
			const stream = await new Promise<Readable>((resolve, reject) => {
				zip.openReadStream(item.entry, (error, input) => {
					if (error) reject(error);
					else resolve(input);
				});
			});
			let written = 0;
			const bound = new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					written += chunk.length;
					callback(
						written > item.entry.uncompressedSize ? new Error("Tool ZIP entry exceeded declared size") : null,
						chunk,
					);
				},
			});
			await pipeline(stream, bound, createWriteStream(target, { flags: "wx", mode: 0o600 }));
			if (written !== item.entry.uncompressedSize) throw new Error("Tool ZIP entry size mismatch");
		}
	} finally {
		zip.close();
	}
}
