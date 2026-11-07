/**
 * Opt-in, best-effort local diagnostics. No production transport depends on it.
 * Only explicitly allowlisted fields are written. Never put content, tokens or
 * paths in numeric fields. peer is a process-local HMAC alias. message is a
 * 128-bit SHA-256 prefix of a native request ID for broker correlation. It is
 * pseudonymous, not anonymous: anyone knowing an ID can match its digest.
 *
 * The ready promise reveals a sensitive local filesystem path to the caller.
 * It is for local operator access only: never log it or return it to a peer.
 * Output is deliberately lossy. The private file remains after close or TTL;
 * operators must delete it when no longer needed. Deletion is not secure erasure.
 * Operators can find native-mesh-diagnostic-* directories in the system temp
 * directory. On Windows, Node mode bits do not protect ACLs; access is inherited
 * from the temp directory and is not verified by this diagnostic.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { VERSION } from "../../../config.js";

const STAGES = [
	"endpoint",
	"sweep",
	"outbox-recovery",
	"register",
	"discover",
	"pending",
	"validation",
	"family",
	"handoff",
	"admission",
	"persistence",
	"persist_frame",
	"ack",
	"store",
	"request",
	"response",
	"delivery",
	"session-sync",
	"persisted-frame",
	"model-processing",
	"reply-generation",
] as const;
const COMPONENTS = ["supervisor", "worker", "unknown"] as const;
const STATUSES = ["start", "success", "failure", "unknown", "skipped", "drop"] as const;
const REASONS = ["timeout", "network", "http", "invalid", "aborted", "other"] as const;
const OPERATIONS = ["register", "discover", "pending", "store", "acknowledge"] as const;
const MAX_TTL_MS = 15 * 60 * 1000;
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_EVENTS_PER_SECOND = 50;
const MAX_NUMBER = 0x7fffffff;
const MAX_QUEUE_BYTES = 64 * 1024;
const DROP_RESERVE_BYTES = 1024;
const CLOSE_WAIT_MS = 2000;
/** Local, cross-platform opt-in. Contents are ignored; the flag is read only once per process. */
export const NATIVE_MESH_DIAGNOSTIC_FLAG = join(tmpdir(), "prime-team-native-mesh-diagnostic.enable");
// Package metadata is not trusted as arbitrary log content.
const packageVersion =
	typeof VERSION === "string" &&
	VERSION.length <= 128 &&
	/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(VERSION)
		? VERSION
		: undefined;

const nodeVersion =
	typeof process.version === "string" &&
	process.version.length <= 129 &&
	/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(process.version)
		? process.version
		: undefined;

export interface NativeMeshDiagnosticEvent {
	stage: (typeof STAGES)[number];
	component?: (typeof COMPONENTS)[number];
	status: (typeof STATUSES)[number];
	reason?: (typeof REASONS)[number];
	operation?: (typeof OPERATIONS)[number];
	/** Raw value exists in memory only and is HMAC-pseudonymized before writing. */
	peer?: string;
	/** Native request ID exists in memory only; its SHA-256 prefix is linkable. */
	subject?: string;
	durationMs?: number;
	count?: number;
	bytes?: number;
	httpStatus?: number;
}
export interface NativeMeshDiagnosticOptions {
	enabled?: boolean;
	ttlMs?: number;
}
export interface NativeMeshDiagnostic {
	record(event: NativeMeshDiagnosticEvent): void;
	/** Sensitive local path; never log, publish, or send it to another host. */
	readonly ready: Promise<string | undefined>;
	close(): Promise<void>;
}

function allowed<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
	return typeof value === "string" && (values as readonly string[]).includes(value);
}
function integer(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function disabled(): NativeMeshDiagnostic {
	return { record() {}, ready: Promise.resolve(undefined), async close() {} };
}

/** Creates an independent diagnostic session. Invalid options fail closed. */
export function createNativeMeshDiagnostic(options?: NativeMeshDiagnosticOptions): NativeMeshDiagnostic {
	try {
		if (options?.enabled !== true || !integer(options.ttlMs, 1, MAX_TTL_MS)) return disabled();
		const ttl = options.ttlMs;
		const key = randomBytes(32);
		const processInstance = randomBytes(16).toString("hex");
		const origin = performance.now();
		const deadline = origin + ttl;
		let closed = false;
		let file: FileHandle | undefined;
		let queue: string[] = [];
		// Includes an in-flight batch, so stalled writes cannot grow memory unbounded.
		let queuedBytes = 0;
		let reservedBytes = 0;
		let dropped = 0;
		let sequence = 0;
		let failed = false;
		let busy: Promise<void> | undefined;
		let windowStart = performance.now();
		let eventsInWindow = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let closing: Promise<void> | undefined;
		const ready = (async (): Promise<string | undefined> => {
			let directory: string | undefined;
			let opened: FileHandle | undefined;
			try {
				directory = await mkdtemp(join(tmpdir(), "native-mesh-diagnostic-"));
				if (process.platform !== "win32") await chmod(directory, 0o700);
				const path = join(directory, "events.jsonl");
				opened = await open(path, "wx", 0o600);
				if (process.platform !== "win32") await opened.chmod(0o600);
				if (performance.now() >= deadline && !closed) void close();
				if (closed && queue.length === 0) {
					await opened.close().catch(() => {});
					await rm(directory, { recursive: true, force: true }).catch(() => {});
					return undefined;
				}
				// A closed session may still need its queued records flushed.
				file = opened;
				return path;
			} catch {
				failed = true;
				if (opened) await opened.close().catch(() => {});
				if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
				return undefined;
			}
		})();
		const drain = (): Promise<void> => {
			if (busy) return busy;
			const run = (async () => {
				await ready;
				while (file && queue.length) {
					const batch = queue.join("");
					queue = [];
					const size = Buffer.byteLength(batch);
					try {
						await file.writeFile(batch, "utf8");
					} catch {
						failed = true;
						queue = [];
						queuedBytes = 0;
						return;
					}
					queuedBytes -= size;
				}
				if (!file) {
					queue = [];
					queuedBytes = 0;
				}
			})();
			busy = run.finally(() => {
				busy = undefined;
				// A record may arrive between run resolving and this finalizer.
				if (queue.length && file && !failed) void drain();
			});
			return busy;
		};
		function close(): Promise<void> {
			if (closing) return closing;
			closed = true;
			if (timer) clearTimeout(timer);
			if (dropped) {
				const line = `${JSON.stringify({
					schema: 1,
					componentVersion: 1,
					packageVersion,
					nodeVersion,
					processInstance,
					at: new Date().toISOString(),
					sequence: ++sequence,
					message: null,
					stage: "endpoint",
					component: "unknown",
					pid: process.pid,
					monotonicMs: Math.floor(performance.now() - origin),
					status: "drop",
					reason: "other",
					count: dropped,
				})}\n`;
				const size = Buffer.byteLength(line);
				if (size <= DROP_RESERVE_BYTES) {
					queue.push(line);
					queuedBytes += size;
				}
			}
			key.fill(0);
			const work = (async () => {
				// A prior drain may already be in flight; it also consumes the final summary.
				await drain();
				if (queue.length && !failed) await drain();
				const current = file;
				file = undefined;
				if (current) await current.close().catch(() => {});
			})().catch(() => {});
			closing = new Promise<void>((resolve) => {
				const limit = setTimeout(resolve, CLOSE_WAIT_MS);
				void work.then(() => {
					clearTimeout(limit);
					resolve();
				});
			});
			return closing;
		}
		timer = setTimeout(() => {
			void close();
		}, ttl);
		timer.unref();
		const record = (event: NativeMeshDiagnosticEvent): void => {
			try {
				const now = performance.now();
				if (closed || failed) return;
				if (now >= deadline) {
					void close();
					return;
				}
				if (!event) return;
				const {
					stage,
					component,
					status,
					reason,
					operation,
					peer: peerInput,
					subject: subjectInput,
					durationMs,
					count,
					bytes,
					httpStatus,
				} = event;
				if (!allowed(STAGES, stage) || !allowed(STATUSES, status)) return;
				if (component !== undefined && !allowed(COMPONENTS, component)) return;
				if (reason !== undefined && !allowed(REASONS, reason)) return;
				if (operation !== undefined && !allowed(OPERATIONS, operation)) return;
				for (const value of [durationMs, count, bytes]) {
					if (value !== undefined && !integer(value, 0, MAX_NUMBER)) return;
				}
				if (httpStatus !== undefined && !integer(httpStatus, 100, 599)) return;
				const alias = (domain: string, value: unknown): string | undefined => {
					if (value === undefined) return undefined;
					if (
						typeof value !== "string" ||
						value.length === 0 ||
						value.length > 512 ||
						Buffer.byteLength(value, "utf8") > 1024
					)
						throw new Error("invalid alias input");
					return createHmac("sha256", key)
						.update(domain)
						.update("\0")
						.update(value, "utf8")
						.digest("hex")
						.slice(0, 32);
				};
				const peer = alias("peer", peerInput);
				if (
					subjectInput !== undefined &&
					(typeof subjectInput !== "string" || !/^nm1m-[a-f0-9]{64}$/.test(subjectInput))
				)
					return;
				const message =
					subjectInput === undefined
						? null
						: createHash("sha256").update(subjectInput, "utf8").digest("hex").slice(0, 32);
				if (sequence >= Number.MAX_SAFE_INTEGER) return;
				const eventSequence = ++sequence;
				if (now - windowStart >= 1000) {
					windowStart = now;
					eventsInWindow = 0;
				}
				const line = `${JSON.stringify({
					schema: 1,
					componentVersion: 1,
					packageVersion,
					nodeVersion,
					processInstance,
					at: new Date().toISOString(),
					sequence: eventSequence,
					message,
					stage,
					component: component ?? "unknown",
					pid: process.pid,
					monotonicMs: Math.floor(now - origin),
					status,
					reason,
					operation,
					peer,
					durationMs,
					count,
					bytes,
					httpStatus,
				})}\n`;
				const size = Buffer.byteLength(line);
				if (
					eventsInWindow >= MAX_EVENTS_PER_SECOND ||
					queuedBytes + size > MAX_QUEUE_BYTES ||
					reservedBytes + size > MAX_LOG_BYTES - DROP_RESERVE_BYTES
				) {
					dropped = Math.min(MAX_NUMBER, dropped + 1);
					return;
				}
				eventsInWindow++;
				reservedBytes += size;
				queuedBytes += size;
				queue.push(line);
				void drain();
			} catch {
				/* Instrumentation must not affect its caller. */
			}
		};
		return { record, ready, close };
	} catch {
		return disabled();
	}
}

function fromEnvironment(): NativeMeshDiagnostic {
	try {
		const enabled = process.env.PI_NATIVE_MESH_DIAGNOSTIC;
		if (enabled !== undefined) {
			const raw = process.env.PI_NATIVE_MESH_DIAGNOSTIC_TTL_MS;
			if (enabled !== "1" || !raw || !/^[0-9]{1,6}$/.test(raw)) return disabled();
			return createNativeMeshDiagnostic({ enabled: true, ttlMs: Number(raw) });
		}
		return existsSync(NATIVE_MESH_DIAGNOSTIC_FLAG)
			? createNativeMeshDiagnostic({ enabled: true, ttlMs: MAX_TTL_MS })
			: disabled();
	} catch {
		return disabled();
	}
}
let singleton: NativeMeshDiagnostic | undefined;
function current(): NativeMeshDiagnostic {
	singleton ??= fromEnvironment();
	return singleton;
}
/** Overrides the singleton for explicit local setup or tests. Prior session closes asynchronously. */
export function configureNativeMeshDiagnostic(options?: NativeMeshDiagnosticOptions): NativeMeshDiagnostic {
	try {
		if (singleton) void singleton.close();
	} catch {
		/* best effort */
	}
	singleton = createNativeMeshDiagnostic(options);
	return singleton;
}
/** Lazy process-local singleton; set env or create the opt-in flag before first use. */
export const nativeMeshDiagnostic: NativeMeshDiagnostic = {
	record(event) {
		try {
			current().record(event);
		} catch {
			/* best effort */
		}
	},
	get ready() {
		try {
			return current().ready;
		} catch {
			return Promise.resolve(undefined);
		}
	},
	close() {
		try {
			return current().close();
		} catch {
			return Promise.resolve();
		}
	},
};
export function recordNativeMeshDiagnostic(event: NativeMeshDiagnosticEvent): void {
	nativeMeshDiagnostic.record(event);
}
