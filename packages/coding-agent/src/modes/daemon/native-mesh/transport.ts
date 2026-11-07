/**
 * Explicitly constructed EnvInHands native-mesh transport seam.
 * This is NOT daemon wiring. Broker data is untrusted and must not authorize or
 * dispatch work. In particular, the shared bearer token does not authenticate
 * an individual sender. The caller must persist an outbox before sending and
 * authenticate, authorize and durably deduplicate before acknowledging.
 */
import { createHash, randomUUID } from "node:crypto";
import { recordNativeMeshDiagnostic } from "./diagnostic.js";

const utf8 = new TextEncoder();
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function nonempty(value: string, label: string): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		/[\u0000-\u001f\u007f]/.test(value) ||
		utf8.encode(value).length > 128
	)
		throw new Error(`Invalid ${label}`);
	return value;
}

function hashPair(prefix: string, first: string, second: string): string {
	nonempty(first, "identity component");
	nonempty(second, "identity component");
	return (
		prefix +
		createHash("sha256")
			.update(JSON.stringify([first, second]), "utf8")
			.digest("hex")
	);
}

/** Protocol v1 opaque host-qualified identifier; not proof of identity. */
export function nativeMeshAgentId(hostId: string, agentId: string): string {
	return hashPair("nm1-", hostId, agentId);
}

/** callerMessageId must be kept stable across retries and process restarts. */
export function nativeMeshRequestId(senderId: string, callerMessageId: string): string {
	if (!/^nm1-[a-f0-9]{64}$/.test(senderId)) throw new Error("Invalid native mesh sender");
	return hashPair("nm1m-", senderId, callerMessageId);
}

export interface NativeMeshRegistration {
	hostId: string;
	agentId: string;
	parentId: string | null;
	name: string;
	state: "active" | "inactive";
}

/** An observation, not an authenticated principal or proof of current liveness. */
export interface NativeMeshObservation extends NativeMeshRegistration {
	id: string;
	lastHeartbeatAt: string;
	status: "observed";
}

function validateRegistration(input: NativeMeshRegistration): void {
	for (const value of [input.hostId, input.agentId, input.name]) {
		nonempty(value, "registration field");
		if (utf8.encode(value).length > 128) throw new Error("Invalid registration field");
	}
	if (input.state !== "active" && input.state !== "inactive") throw new Error("Invalid registration state");
	if (
		input.parentId !== null &&
		(!/^nm1-[a-f0-9]{64}$/.test(input.parentId) || input.parentId === nativeMeshAgentId(input.hostId, input.agentId))
	)
		throw new Error("Invalid registration parent");
}

function observation(value: unknown): NativeMeshObservation | undefined {
	const v = record(value);
	if (
		!v ||
		typeof v.hostId !== "string" ||
		typeof v.agentId !== "string" ||
		typeof v.name !== "string" ||
		(v.parentId !== null && typeof v.parentId !== "string") ||
		(v.state !== "active" && v.state !== "inactive") ||
		typeof v.lastHeartbeatAt !== "string" ||
		!Number.isFinite(Date.parse(v.lastHeartbeatAt)) ||
		v.status !== "observed"
	)
		return undefined;
	const entry = v as unknown as NativeMeshObservation;
	try {
		validateRegistration(entry);
	} catch {
		return undefined;
	}
	return entry.id === nativeMeshAgentId(entry.hostId, entry.agentId) ? entry : undefined;
}

export interface NativeMeshMessage {
	requestId: string;
	from: string;
	to: string;
	text: string;
	createdAt: string;
	acknowledgedAt: string | null;
}

export class NativeMeshRequestError extends Error {
	constructor(
		readonly operation: string,
		readonly outcome: "rejected" | "unknown",
		readonly status?: number,
	) {
		super(`Native mesh ${operation}: ${outcome}${status === undefined ? "" : ` (HTTP ${status})`}`);
	}
}

type TracedOperation = "register" | "discover" | "pending";

function validationFailure(operation: TracedOperation): NativeMeshRequestError {
	recordNativeMeshDiagnostic({
		component: "supervisor",
		operation,
		stage: "validation",
		status: "failure",
		reason: "invalid",
	});
	return new NativeMeshRequestError(operation, "unknown");
}

export interface NativeMeshTransportOptions {
	url: string;
	token: string;
	/** Base64url EnvInHands registration declaration; it is not authentication. */
	registration?: string;
	/** Per-request timeout; an explicit value also preserves the discovery budget unless overridden. */
	timeoutMs?: number;
	/** Total deadline for a consistent discovery scan, including 409 retries. */
	discoveryTimeoutMs?: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function message(value: unknown): NativeMeshMessage | undefined {
	const m = record(value);
	if (
		!m ||
		typeof m.requestId !== "string" ||
		typeof m.from !== "string" ||
		typeof m.to !== "string" ||
		typeof m.text !== "string" ||
		typeof m.createdAt !== "string" ||
		(m.acknowledgedAt !== null && typeof m.acknowledgedAt !== "string")
	)
		return undefined;
	return m as unknown as NativeMeshMessage;
}

async function boundedJson(response: Response, account?: (bytes: number) => void): Promise<unknown> {
	if (!response.body) throw new Error("Missing response body");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > MAX_RESPONSE_BYTES) throw new Error("Response too large");
			account?.(part.value.byteLength);
			chunks.push(part.value);
		}
	} catch (error) {
		void reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

export class NativeMeshTransport {
	private readonly base: URL;
	private readonly timeoutMs: number;
	private readonly discoveryTimeoutMs: number;
	constructor(private readonly options: NativeMeshTransportOptions) {
		this.base = new URL(options.url);
		const local =
			this.base.hostname === "127.0.0.1" || this.base.hostname === "[::1]" || this.base.hostname === "localhost";
		if (
			(this.base.protocol !== "https:" && !(this.base.protocol === "http:" && local)) ||
			this.base.username ||
			this.base.password ||
			this.base.search ||
			this.base.hash ||
			this.base.pathname !== "/"
		)
			throw new Error("Native mesh URL must be an HTTPS origin or a loopback HTTP origin");
		if (!options.token || /[\r\n]/.test(options.token)) throw new Error("Invalid native mesh token");
		if (options.registration && !/^[A-Za-z0-9_-]{1,4096}$/.test(options.registration))
			throw new Error("Invalid registration declaration");
		this.timeoutMs = options.timeoutMs ?? 10_000;
		if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000)
			throw new Error("Invalid timeout");
		this.discoveryTimeoutMs = options.discoveryTimeoutMs ?? options.timeoutMs ?? 60_000;
		if (
			!Number.isInteger(this.discoveryTimeoutMs) ||
			this.discoveryTimeoutMs < 1 ||
			this.discoveryTimeoutMs > 120_000
		)
			throw new Error("Invalid discovery timeout");
	}

	private async request(
		operation: string,
		path: string,
		method: "GET" | "POST",
		body?: object,
		budget?: { deadline: number; account: (bytes: number) => void },
	): Promise<unknown> {
		const traced =
			operation === "register" || operation === "discover" || operation === "pending" ? operation : undefined;
		if (traced)
			recordNativeMeshDiagnostic({ component: "supervisor", operation: traced, stage: "request", status: "start" });
		const headers: Record<string, string> = { authorization: `Bearer ${this.options.token}` };
		if (body !== undefined) headers["content-type"] = "application/json";
		if (method === "POST" && this.options.registration) {
			headers["x-envinhands-registration"] = this.options.registration;
			headers["x-envinhands-operation-id"] = randomUUID();
		}
		let response: Response;
		const remaining = budget ? Math.min(this.timeoutMs, budget.deadline - Date.now()) : this.timeoutMs;
		if (remaining < 1) {
			if (traced)
				recordNativeMeshDiagnostic({
					component: "supervisor",
					operation: traced,
					stage: "request",
					status: "failure",
					reason: "timeout",
				});
			throw new NativeMeshRequestError(operation, "unknown");
		}
		try {
			response = await fetch(new URL(path, this.base), {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				redirect: "error",
				signal: AbortSignal.timeout(remaining),
			});
		} catch {
			if (traced)
				recordNativeMeshDiagnostic({
					component: "supervisor",
					operation: traced,
					stage: "request",
					status: "failure",
					reason: "other",
				});
			throw new NativeMeshRequestError(operation, "unknown");
		}
		if (!response.ok) {
			if (traced)
				recordNativeMeshDiagnostic({
					component: "supervisor",
					operation: traced,
					stage: "response",
					status: "failure",
					reason: "http",
					httpStatus: response.status,
				});
			void response.body?.cancel().catch(() => {});
			throw new NativeMeshRequestError(
				operation,
				response.status >= 400 && response.status < 500 ? "rejected" : "unknown",
				response.status,
			);
		}
		try {
			return await boundedJson(response, budget?.account);
		} catch {
			if (traced)
				recordNativeMeshDiagnostic({
					component: "supervisor",
					operation: traced,
					stage: "response",
					status: "failure",
					reason: "other",
					httpStatus: response.status,
				});
			throw new NativeMeshRequestError(operation, "unknown", response.status);
		}
	}

	/** Publish a heartbeat. This declaration does not prove agent identity. */
	async register(input: NativeMeshRegistration): Promise<NativeMeshObservation> {
		try {
			validateRegistration(input);
		} catch (error) {
			recordNativeMeshDiagnostic({
				component: "supervisor",
				operation: "register",
				stage: "validation",
				status: "failure",
				reason: "invalid",
			});
			throw error;
		}
		const result = record(await this.request("register", "/v1/native-mesh/agents", "POST", input));
		const agent = observation(result?.agent);
		if (
			!agent ||
			agent.hostId !== input.hostId ||
			agent.agentId !== input.agentId ||
			agent.name !== input.name ||
			agent.parentId !== input.parentId ||
			agent.state !== input.state
		)
			throw validationFailure("register");
		recordNativeMeshDiagnostic({
			component: "supervisor",
			operation: "register",
			stage: "validation",
			status: "success",
		});
		return agent;
	}

	/** Observations may be stale or forged; apply local trust and expiry policy.
	 * v2 is a revision-checked keyset scan, not proof of liveness or authority.
	 * An old server may return its complete unversioned response (up to 2 MiB).
	 * Upgrade the server first: old clients fail with 413 once its legacy bound
	 * is exceeded, rather than receiving a silently truncated directory.
	 */
	async discover(): Promise<NativeMeshObservation[]> {
		const started = Date.now();
		const deadline = started + this.discoveryTimeoutMs;
		let pages = 0;
		let pageLimit = 4000;
		let negotiating = true;
		let bytes = 0,
			records = 0;
		const budget = {
			deadline,
			account: (n: number) => {
				bytes += n;
				if (bytes > 32 * 1024 * 1024) throw new Error("Discovery byte budget exceeded");
			},
		};
		for (let attempt = 0; attempt < 3; attempt++) {
			const all: NativeMeshObservation[] = [];
			let after: string | undefined;
			let revision: string | undefined;
			try {
				for (;;) {
					const query = new URLSearchParams({ limit: String(pageLimit) });
					if (after !== undefined) {
						query.set("after", after);
						query.set("revision", revision!);
					}
					let raw: unknown;
					try {
						raw = await this.request("discover", `/v1/native-mesh/agents?${query}`, "GET", undefined, budget);
					} catch (error) {
						// Negotiate only on consecutive initial 400s, before any page or 409 retry.
						if (
							negotiating &&
							pageLimit > 100 &&
							error instanceof NativeMeshRequestError &&
							error.status === 400
						) {
							pageLimit = pageLimit === 4000 ? 1000 : 100;
							recordNativeMeshDiagnostic({
								component: "supervisor",
								operation: "discover",
								stage: "discover",
								status: "skipped",
								httpStatus: 400,
							});
							continue;
						}
						negotiating = false;
						throw error;
					}
					negotiating = false;
					const result = record(raw);
					if (!Array.isArray(result?.agents)) throw validationFailure("discover");
					const agents = result.agents.map(observation);
					if (agents.some((a) => !a)) throw validationFailure("discover");
					pages++;
					if (result.version === undefined && after === undefined) {
						// Legacy servers returned the entire directory, without a cursor.
						if (
							"nextCursor" in result ||
							"revision" in result ||
							new Set(agents.map((a) => a!.id)).size !== agents.length
						)
							throw validationFailure("discover");
						recordNativeMeshDiagnostic({
							component: "supervisor",
							operation: "discover",
							stage: "validation",
							status: "success",
							count: agents.length,
						});
						recordNativeMeshDiagnostic({
							component: "supervisor",
							operation: "discover",
							stage: "discover",
							status: "success",
							count: pages,
							bytes,
							durationMs: Math.max(0, Date.now() - started),
						});
						return agents as NativeMeshObservation[];
					}
					if (
						result.version !== 2 ||
						typeof result.revision !== "string" ||
						!/^(0|[1-9][0-9]{0,18})$/.test(result.revision) ||
						(revision !== undefined && revision !== result.revision) ||
						agents.length > pageLimit
					)
						throw validationFailure("discover");
					revision = result.revision;
					for (const agent of agents as NativeMeshObservation[]) {
						if (after !== undefined && agent.id <= after) throw validationFailure("discover");
						after = agent.id;
						all.push(agent);
						if (++records > 100_000) throw validationFailure("discover");
					}
					if (result.nextCursor === null) {
						recordNativeMeshDiagnostic({
							component: "supervisor",
							operation: "discover",
							stage: "validation",
							status: "success",
							count: all.length,
						});
						recordNativeMeshDiagnostic({
							component: "supervisor",
							operation: "discover",
							stage: "discover",
							status: "success",
							count: pages,
							bytes,
							durationMs: Math.max(0, Date.now() - started),
						});
						return all;
					}
					if (agents.length === 0 || result.nextCursor !== after) throw validationFailure("discover");
				}
			} catch (error) {
				if (error instanceof NativeMeshRequestError && error.status === 409 && attempt < 2) {
					recordNativeMeshDiagnostic({
						component: "supervisor",
						operation: "discover",
						stage: "discover",
						status: "skipped",
						httpStatus: 409,
						count: pages,
						bytes,
						durationMs: Math.max(0, Date.now() - started),
					});
					continue;
				}
				recordNativeMeshDiagnostic({
					component: "supervisor",
					operation: "discover",
					stage: "discover",
					status: "unknown",
					count: pages,
					bytes,
					durationMs: Math.max(0, Date.now() - started),
				});
				throw error;
			}
		}
		throw new NativeMeshRequestError("discover", "unknown");
	}

	/** Only confirms broker storage, never recipient delivery or processing. */
	async store(input: {
		from: string;
		to: string;
		callerMessageId: string;
		text: string;
	}): Promise<{ requestId: string; deliveryStatus: "stored" }> {
		const from = nonempty(input.from, "sender");
		const to = nonempty(input.to, "recipient");
		if (!/^nm1-[a-f0-9]{64}$/.test(from) || !/^nm1-[a-f0-9]{64}$/.test(to))
			throw new Error("Invalid native mesh endpoint");
		if (
			typeof input.text !== "string" ||
			!input.text.trim() ||
			input.text.includes("\0") ||
			utf8.encode(input.text).length > 8192
		)
			throw new Error("Invalid native mesh message text");
		const requestId = nativeMeshRequestId(from, input.callerMessageId);
		const started = Date.now();
		recordNativeMeshDiagnostic({ component: "supervisor", stage: "store", status: "start", subject: requestId });
		let response: unknown;
		try {
			response = await this.request("store", "/v1/messages", "POST", { requestId, from, to, text: input.text });
		} catch (error) {
			recordNativeMeshDiagnostic({
				component: "supervisor",
				stage: "store",
				status: "unknown",
				subject: requestId,
				durationMs: Date.now() - started,
			});
			throw error;
		}
		const result = record(response);
		const m = message(result?.message);
		if (
			result?.status !== "accepted" ||
			!m ||
			m.requestId !== requestId ||
			m.from !== from ||
			m.to !== to ||
			m.text !== input.text
		) {
			recordNativeMeshDiagnostic({
				component: "supervisor",
				stage: "store",
				status: "unknown",
				subject: requestId,
				durationMs: Date.now() - started,
			});
			throw new NativeMeshRequestError("store", "unknown");
		}
		recordNativeMeshDiagnostic({
			component: "supervisor",
			stage: "store",
			status: "success",
			subject: requestId,
			durationMs: Date.now() - started,
		});
		return { requestId, deliveryStatus: "stored" };
	}

	/** Untrusted, unclaimed data; do not execute or acknowledge before durable handling. */
	async pending(to: string): Promise<NativeMeshMessage[]> {
		if (!/^nm1-[a-f0-9]{64}$/.test(to)) {
			recordNativeMeshDiagnostic({
				component: "supervisor",
				operation: "pending",
				stage: "validation",
				status: "failure",
				reason: "invalid",
			});
			throw new Error("Invalid native mesh endpoint");
		}
		const result = record(await this.request("pending", `/v1/messages?to=${encodeURIComponent(to)}`, "GET"));
		if (!Array.isArray(result?.messages)) throw validationFailure("pending");
		const messages = result.messages.map(message);
		if (
			messages.some(
				(m) =>
					!m ||
					m.to !== to ||
					m.acknowledgedAt !== null ||
					!/^nm1-[a-f0-9]{64}$/.test(m.from) ||
					!/^nm1m-[a-f0-9]{64}$/.test(m.requestId) ||
					!m.text.trim() ||
					m.text.includes("\0") ||
					utf8.encode(m.text).length > 8192 ||
					!Number.isFinite(Date.parse(m.createdAt)),
			) ||
			new Set(messages.map((m) => m!.requestId)).size !== messages.length
		)
			throw validationFailure("pending");
		recordNativeMeshDiagnostic({
			component: "supervisor",
			operation: "pending",
			stage: "validation",
			status: "success",
			count: messages.length,
		});
		return messages as NativeMeshMessage[];
	}

	/** The caller is responsible for durable, replay-safe handling first. */
	async acknowledge(requestId: string): Promise<void> {
		if (!/^nm1m-[a-f0-9]{64}$/.test(requestId)) throw new Error("Invalid native mesh request ID");
		const result = record(
			await this.request("acknowledge", `/v1/messages/${encodeURIComponent(requestId)}/ack`, "POST"),
		);
		const m = message(result?.message);
		if (result?.status !== "acknowledged" || !m || m.requestId !== requestId || !m.acknowledgedAt)
			throw new NativeMeshRequestError("acknowledge", "unknown");
	}
}
