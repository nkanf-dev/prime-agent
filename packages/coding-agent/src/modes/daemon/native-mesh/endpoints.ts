/** Durable native endpoint bindings. One supervisor must exclusively own writes. */
import { mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalSessionPath } from "../../../core/session-lease.js";
import { writeFileAtomicSync } from "../../../utils/atomic-file.js";

export interface NativeMeshEndpointAncestor {
	sessionId: string;
	sessionPath: string;
}

export interface NativeMeshEndpoint {
	machineId: string;
	sessionId: string;
	sessionPath: string;
	rootPath: string;
	rootSessionId: string;
	/** Ordered from immediate parent to root; empty for a root. */
	ancestors: NativeMeshEndpointAncestor[];
	name: string;
	cwd: string;
	rlmDepth: number;
}

type EndpointKey = { machineId: string; sessionId: string };
type Registry = { version: 1; endpoints: NativeMeshEndpoint[]; blocked?: EndpointKey[] };

function nonempty(value: unknown): value is string {
	return typeof value === "string" && !!value.trim() && !value.includes("\0");
}
function validPath(value: unknown): value is string {
	return nonempty(value) && isAbsolute(value);
}
function validate(value: unknown): asserts value is NativeMeshEndpoint {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native mesh endpoint");
	const item = value as NativeMeshEndpoint;
	if (
		!nonempty(item.machineId) ||
		!nonempty(item.sessionId) ||
		!nonempty(item.rootSessionId) ||
		!validPath(item.sessionPath) ||
		!validPath(item.rootPath) ||
		typeof item.name !== "string" ||
		item.name.includes("\0") ||
		!nonempty(item.cwd) ||
		!Array.isArray(item.ancestors) ||
		!Number.isSafeInteger(item.rlmDepth) ||
		item.rlmDepth !== item.ancestors.length
	)
		throw new Error("Invalid native mesh endpoint");
	const ids = new Set([item.sessionId]);
	const paths = new Set([item.sessionPath]);
	for (const ancestor of item.ancestors) {
		if (
			!ancestor ||
			!nonempty(ancestor.sessionId) ||
			!validPath(ancestor.sessionPath) ||
			ids.has(ancestor.sessionId) ||
			paths.has(ancestor.sessionPath)
		)
			throw new Error("Invalid native mesh endpoint ancestry");
		ids.add(ancestor.sessionId);
		paths.add(ancestor.sessionPath);
	}
	const root = item.ancestors.at(-1) ?? item;
	if (root.sessionId !== item.rootSessionId || root.sessionPath !== item.rootPath)
		throw new Error("Invalid native mesh endpoint root");
}

function copy(item: NativeMeshEndpoint): NativeMeshEndpoint {
	return { ...item, ancestors: item.ancestors.map((ancestor) => ({ ...ancestor })) };
}

/**
 * The directory is private supervisor state, with exactly one writing supervisor.
 * It is loaded once. Atomic replacement prevents partially written reads, but does
 * not serialize competing writers. Registration policy belongs to the caller.
 */
export class NativeMeshEndpoints {
	private readonly path: string;
	private items: NativeMeshEndpoint[];
	private blocked: EndpointKey[];
	private quarantinePending = false;
	constructor(directory: string) {
		const resolved = resolve(directory);
		mkdirSync(resolved, { recursive: true, mode: 0o700 });
		this.path = join(resolved, "endpoints.json");
		const state = this.load();
		this.items = state.endpoints;
		this.blocked = state.blocked ?? [];
	}

	read(machineId: string, sessionId: string): NativeMeshEndpoint | undefined {
		this.validateKey(machineId, sessionId);
		if (this.isBlocked(machineId, sessionId)) return undefined;
		const item = this.items.find((entry) => entry.machineId === machineId && entry.sessionId === sessionId);
		return item ? copy(item) : undefined;
	}

	list(machineId: string): NativeMeshEndpoint[] {
		if (!nonempty(machineId)) throw new Error("Invalid native mesh endpoint identity");
		return this.items
			.filter((item) => item.machineId === machineId && !this.isBlocked(machineId, item.sessionId))
			.map(copy);
	}

	/** The same identity cannot silently move to another session file. */
	upsert(input: NativeMeshEndpoint): void {
		if (
			!input ||
			!nonempty(input.sessionPath) ||
			!nonempty(input.rootPath) ||
			!Array.isArray(input.ancestors) ||
			input.ancestors.some((ancestor) => !ancestor || !nonempty(ancestor.sessionPath))
		)
			throw new Error("Invalid native mesh endpoint");
		const item: NativeMeshEndpoint = {
			machineId: input.machineId,
			sessionId: input.sessionId,
			sessionPath: canonicalSessionPath(input.sessionPath),
			rootPath: canonicalSessionPath(input.rootPath),
			rootSessionId: input.rootSessionId,
			ancestors: input.ancestors.map((ancestor) => ({
				sessionId: ancestor.sessionId,
				sessionPath: canonicalSessionPath(ancestor.sessionPath),
			})),
			name: input.name,
			cwd: input.cwd,
			rlmDepth: input.rlmDepth,
		};
		validate(item);
		if (this.isBlocked(item.machineId, item.sessionId)) throw new Error("Quarantined native mesh endpoint");
		const items = [...this.items];
		const index = items.findIndex((old) => old.machineId === item.machineId && old.sessionId === item.sessionId);
		if (index >= 0) {
			if (items[index].sessionPath !== item.sessionPath) {
				this.quarantine(item.machineId, item.sessionId);
				throw new Error("Conflicting native mesh endpoint session path");
			}
			if (JSON.stringify(items[index]) === JSON.stringify(item)) return;
			items[index] = item;
		} else items.push(item);
		this.save(items);
		this.items = items;
	}

	/** Block a key durably, including keys that do not yet have a binding. */
	quarantine(machineId: string, sessionId: string): void {
		this.validateKey(machineId, sessionId);
		const alreadyBlocked = this.isBlocked(machineId, sessionId);
		if (alreadyBlocked && !this.quarantinePending) return;
		const blocked = alreadyBlocked ? this.blocked : [...this.blocked, { machineId, sessionId }];
		// Even if persistence fails, do not route it during this process. The caller
		// must stop routing on that error because restart cannot recover this state.
		this.blocked = blocked;
		this.quarantinePending = true;
		this.save(this.items, blocked);
	}

	/** Remove both a binding and any quarantine; returns whether either existed. */
	remove(machineId: string, sessionId: string): boolean {
		this.validateKey(machineId, sessionId);
		const items = this.items.filter((item) => item.machineId !== machineId || item.sessionId !== sessionId);
		const blocked = this.blocked.filter((item) => item.machineId !== machineId || item.sessionId !== sessionId);
		if (items.length === this.items.length && blocked.length === this.blocked.length) return false;
		this.save(items, blocked);
		this.items = items;
		this.blocked = blocked;
		return true;
	}

	private isBlocked(machineId: string, sessionId: string): boolean {
		return this.blocked.some((item) => item.machineId === machineId && item.sessionId === sessionId);
	}

	private validateKey(machineId: string, sessionId: string): void {
		if (!nonempty(machineId) || !nonempty(sessionId)) throw new Error("Invalid native mesh endpoint identity");
	}

	private load(): Registry {
		let text: string;
		try {
			text = readFileSync(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, endpoints: [], blocked: [] };
			throw error;
		}
		const data: unknown = JSON.parse(text);
		if (
			!data ||
			typeof data !== "object" ||
			Array.isArray(data) ||
			(data as Registry).version !== 1 ||
			!Array.isArray((data as Registry).endpoints)
		)
			throw new Error("Invalid native mesh endpoint registry");
		const items = (data as Registry).endpoints;
		const keys = new Map<string, Set<string>>();
		for (const item of items) {
			validate(item);
			let sessions = keys.get(item.machineId);
			if (!sessions) {
				sessions = new Set();
				keys.set(item.machineId, sessions);
			}
			if (sessions.has(item.sessionId)) throw new Error("Duplicate native mesh endpoint identity");
			sessions.add(item.sessionId);
		}
		const rawBlocked = (data as Registry).blocked;
		if (rawBlocked !== undefined && !Array.isArray(rawBlocked))
			throw new Error("Invalid native mesh endpoint registry");
		const blocked = rawBlocked ?? [];
		const blockedKeys = new Map<string, Set<string>>();
		for (const key of blocked) {
			if (!key || typeof key !== "object" || !nonempty(key.machineId) || !nonempty(key.sessionId))
				throw new Error("Invalid native mesh endpoint quarantine");
			let sessions = blockedKeys.get(key.machineId);
			if (!sessions) {
				sessions = new Set();
				blockedKeys.set(key.machineId, sessions);
			}
			if (sessions.has(key.sessionId)) throw new Error("Duplicate native mesh endpoint quarantine");
			sessions.add(key.sessionId);
		}
		return { version: 1, endpoints: items, blocked };
	}

	private save(endpoints: NativeMeshEndpoint[], blocked: EndpointKey[] = this.blocked): void {
		writeFileAtomicSync(this.path, `${JSON.stringify({ version: 1, endpoints, blocked })}\n`, {
			mode: 0o600,
			fsync: true,
			fsyncDir: true,
		});
		this.quarantinePending = false;
	}
}
