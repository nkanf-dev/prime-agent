/**
 * Permanent operation bindings. This journal is separate from the delivery
 * outbox: a successful delivery must not remove the operation binding.
 * The journal directory must be private and must not be modified externally.
 */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { nativeMeshRequestId } from "./transport.js";

export interface NativeMeshOperation {
	version: 1;
	from: string;
	to: string;
	text: string;
	operationId: string;
}

export type NativeMeshOperationInput = Omit<NativeMeshOperation, "version">;

function syncDirectory(path: string): void {
	// Node cannot fsync a directory on Windows (EPERM). File contents are still
	// fsynced before publication, but power-loss durability of directory entries
	// is not guaranteed on Windows. Do not suppress Unix errors.
	if (process.platform === "win32") return;
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function validate(item: NativeMeshOperation): void {
	if (
		item.version !== 1 ||
		typeof item.from !== "string" ||
		!/^nm1-[a-f0-9]{64}$/.test(item.from) ||
		typeof item.to !== "string" ||
		!/^nm1-[a-f0-9]{64}$/.test(item.to) ||
		typeof item.operationId !== "string" ||
		!item.operationId.trim() ||
		/[\u0000-\u001f\u007f]/.test(item.operationId) ||
		Buffer.byteLength(item.operationId) > 128 ||
		typeof item.text !== "string" ||
		!item.text.trim() ||
		item.text.includes("\0") ||
		Buffer.byteLength(item.text) > 8192
	)
		throw new Error("Invalid native mesh operation");
}

export class NativeMeshOperations {
	private readonly directory: string;
	constructor(directory: string) {
		this.directory = resolve(directory);
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		// Persist each directory entry, including recursively created ancestors.
		// This also covers another constructor creating an ancestor concurrently.
		let current = this.directory;
		while (true) {
			const parent = dirname(current);
			syncDirectory(parent);
			if (parent === current) break;
			current = parent;
		}
	}

	/** Durably bind an operation before enqueueing it. Equal retries return the same ID. */
	bind(input: NativeMeshOperationInput): string {
		const item: NativeMeshOperation = {
			version: 1,
			from: input.from,
			to: input.to,
			text: input.text,
			operationId: input.operationId,
		};
		validate(item);
		const id = nativeMeshRequestId(item.from, item.operationId);
		const path = this.path(id);
		const temp = join(this.directory, `.tmp-${randomUUID()}`);
		let created = false;
		try {
			const fd = openSync(temp, "wx", 0o600);
			created = true;
			try {
				writeFileSync(fd, `${JSON.stringify(item)}\n`);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			try {
				// A hard link publishes a fully synced file atomically, without replacing
				// an existing binding even when multiple processes race to bind it.
				linkSync(temp, path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const existing = this.read(id);
				if (
					existing.from !== item.from ||
					existing.to !== item.to ||
					existing.text !== item.text ||
					existing.operationId !== item.operationId
				)
					throw new Error("Conflicting native mesh operation");
			}
			// Also sync on duplicate: a competing publisher may not have synced the
			// directory yet, or a previous attempt may have failed at this step.
			syncDirectory(this.directory);
			return id;
		} finally {
			if (created) {
				try {
					unlinkSync(temp);
				} catch {}
			}
		}
	}

	/** Bindings without a durable stored marker must be retried, including legacy bindings. */
	pending(): string[] {
		const ids = readdirSync(this.directory)
			.filter((name) => /^nm1m-[a-f0-9]{64}\.json$/.test(name))
			.map((name) => name.slice(0, -5))
			.sort();
		return ids.filter((id) => {
			this.read(id);
			try {
				if (readFileSync(this.markerPath(id), "utf8") !== `${id}\n`)
					throw new Error("Invalid native mesh stored marker");
				return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
				throw error;
			}
		});
	}

	/** Record a broker-confirmed store; never call for an unknown or failed store. */
	markStored(id: string): void {
		this.read(id);
		const temp = join(this.directory, `.tmp-${randomUUID()}`);
		let created = false;
		try {
			const fd = openSync(temp, "wx", 0o600);
			created = true;
			try {
				writeFileSync(fd, `${id}\n`);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			try {
				linkSync(temp, this.markerPath(id));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (readFileSync(this.markerPath(id), "utf8") !== `${id}\n`)
					throw new Error("Invalid native mesh stored marker");
			}
			syncDirectory(this.directory);
		} finally {
			if (created) {
				try {
					unlinkSync(temp);
				} catch {}
			}
		}
	}

	/** Look up an operation before deciding whether a new binding is authorized. */
	get(from: string, operationId: string): NativeMeshOperation | undefined {
		const id = nativeMeshRequestId(from, operationId);
		try {
			return this.read(id);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	/** Fail closed on malformed or identity-mismatched journal entries. */
	read(id: string): NativeMeshOperation {
		if (!/^nm1m-[a-f0-9]{64}$/.test(id)) throw new Error("Invalid native mesh request ID");
		const item = JSON.parse(readFileSync(this.path(id), "utf8")) as NativeMeshOperation;
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid native mesh operation");
		validate(item);
		if (nativeMeshRequestId(item.from, item.operationId) !== id)
			throw new Error("Native mesh operation identity mismatch");
		return item;
	}

	private path(id: string): string {
		return join(this.directory, `${id}.json`);
	}
	private markerPath(id: string): string {
		return join(this.directory, `${id}.stored`);
	}
}
