/**
 * Supervisor-owned durable outbox for EnvInHands native mesh. This helper does
 * not enable mesh or assert delivery. One daemon must exclusively own the
 * directory. A successful store confirms broker storage only.
 */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type NativeMeshTransport, nativeMeshRequestId } from "./transport.js";

export interface NativeMeshOutboxItem {
	version: 1;
	from: string;
	to: string;
	callerMessageId: string;
	text: string;
}

type Store = Pick<NativeMeshTransport, "store">;

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

function validate(item: NativeMeshOutboxItem): void {
	if (
		item.version !== 1 ||
		!/^nm1-[a-f0-9]{64}$/.test(item.from) ||
		!/^nm1-[a-f0-9]{64}$/.test(item.to) ||
		typeof item.callerMessageId !== "string" ||
		!item.callerMessageId.trim() ||
		/[\u0000-\u001f\u007f]/.test(item.callerMessageId) ||
		Buffer.byteLength(item.callerMessageId) > 128 ||
		typeof item.text !== "string" ||
		!item.text.trim() ||
		item.text.includes("\0") ||
		Buffer.byteLength(item.text) > 8192
	)
		throw new Error("Invalid native mesh outbox item");
}

export class NativeMeshOutbox {
	private readonly inFlight = new Map<string, Promise<void>>();
	constructor(
		private readonly directory: string,
		private readonly transport: Store,
		private readonly onStored?: (id: string) => void,
	) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		// The daemon supplies an existing descriptor directory as the parent.
		// Persist creation of the outbox directory before accepting entries.
		syncDirectory(dirname(directory));
	}

	/** Commit the stable request identity before the first network attempt. */
	enqueue(input: { from: string; to: string; text: string; callerMessageId?: string }): string {
		const item: NativeMeshOutboxItem = {
			version: 1,
			from: input.from,
			to: input.to,
			text: input.text,
			callerMessageId: input.callerMessageId ?? randomUUID(),
		};
		validate(item);
		const id = nativeMeshRequestId(item.from, item.callerMessageId);
		const path = this.path(id);
		try {
			const old = this.read(id);
			if (JSON.stringify(old) !== JSON.stringify(item)) throw new Error("Conflicting native mesh outbox request");
			return id;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const temp = join(this.directory, `.tmp-${randomUUID()}`);
		const fd = openSync(temp, "wx", 0o600);
		try {
			writeFileSync(fd, `${JSON.stringify(item)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		try {
			renameSync(temp, path);
			syncDirectory(this.directory);
		} catch (error) {
			try {
				unlinkSync(temp);
			} catch {}
			throw error;
		}
		return id;
	}

	/** A corrupt file is an error, never silently discarded or sent. */
	pending(): string[] {
		return readdirSync(this.directory)
			.filter((name) => /^nm1m-[a-f0-9]{64}\.json$/.test(name))
			.map((name) => name.slice(0, -5))
			.sort();
	}

	read(id: string): NativeMeshOutboxItem {
		if (!/^nm1m-[a-f0-9]{64}$/.test(id)) throw new Error("Invalid native mesh request ID");
		const item = JSON.parse(readFileSync(this.path(id), "utf8")) as NativeMeshOutboxItem;
		validate(item);
		if (nativeMeshRequestId(item.from, item.callerMessageId) !== id)
			throw new Error("Native mesh outbox identity mismatch");
		return item;
	}

	/** On any unknown/rejected outcome, retain the exact item for safe retry. */
	async send(id: string): Promise<void> {
		const active = this.inFlight.get(id);
		if (active) return active;
		const send = this.sendOnce(id);
		this.inFlight.set(id, send);
		try {
			await send;
		} finally {
			if (this.inFlight.get(id) === send) this.inFlight.delete(id);
		}
	}

	private async sendOnce(id: string): Promise<void> {
		const item = this.read(id);
		const result = await this.transport.store(item);
		if (result.requestId !== id || result.deliveryStatus !== "stored")
			throw new Error("Invalid native mesh storage receipt");
		// Persist the operation's storage receipt before removing its durable outbox item.
		this.onStored?.(id);
		unlinkSync(this.path(id));
		syncDirectory(this.directory);
	}

	private path(id: string): string {
		return join(this.directory, `${id}.json`);
	}
}
