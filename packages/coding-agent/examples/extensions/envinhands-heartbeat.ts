/** Experimental opt-in EnvInHands activity reporter. See docs/envinhands-integration.md. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Lifecycle = "session_start" | "session_shutdown" | "agent_start" | "agent_end";

export default function (pi: ExtensionAPI) {
	const { ENVINHANDS_URL: base, ENVINHANDS_TOKEN: token, ENVINHANDS_AGENT_ID: agentId, ENVINHANDS_MACHINE_ID: machineId } = process.env;
	if (!base || !token || !agentId || !machineId) return;
	// IDs are deliberately restricted: do not use prompts, paths, or secrets as identifiers.
	if (![agentId, machineId].every((id) => /^[A-Za-z0-9_.-]{1,128}$/.test(id))) return;
	let url: URL;
	try {
		url = new URL(base);
	} catch {
		return;
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	// This opt-in sends the bearer token and request data in plaintext over HTTP.
	if ((url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || process.env.ENVINHANDS_ALLOW_INSECURE_HTTP === "1"))) || url.username || url.password || url.search || url.hash || url.pathname !== "/") return;
	const endpoint = new URL("/v1/agents/heartbeat", url);
	let active = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let pending = 0;
	function heartbeat(task?: Lifecycle) {
		// Bound resource use during a slow or unavailable service. Delivery is best effort.
		if (pending >= 4) return;
		pending++;
		void fetch(endpoint, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ agentId, machineId, ...(task ? { task } : {}) }),
			signal: AbortSignal.timeout(2000),
			redirect: "error",
		}).catch(() => {}).finally(() => { pending--; });
	}
	pi.on("session_start", () => {
		active = true;
		heartbeat("session_start");
		if (!timer) {
			timer = setInterval(() => heartbeat(), 30_000);
			timer.unref();
		}
	});
	pi.on("agent_start", () => { if (active) heartbeat("agent_start"); });
	pi.on("agent_end", () => { if (active) heartbeat("agent_end"); });
	pi.on("session_shutdown", () => {
		if (!active) return;
		active = false;
		if (timer) clearInterval(timer);
		timer = undefined;
		heartbeat("session_shutdown");
	});
}
