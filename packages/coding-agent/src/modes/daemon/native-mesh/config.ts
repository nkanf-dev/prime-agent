import { NativeMeshTransport } from "./transport.js";

/** Native mesh is opt-in. This parser does not start or wire a daemon. */
export interface NativeMeshConfig {
	url: string;
	token: string;
	machineId: string;
}

export function nativeMeshConfigFromEnvironment(env: NodeJS.ProcessEnv): NativeMeshConfig | undefined {
	const keys = ["PRIME_AGENT_TEAM_MESH_URL", "PRIME_AGENT_TEAM_MESH_TOKEN", "PRIME_AGENT_TEAM_MACHINE_ID"] as const;
	const values = keys.map((key) => env[key]);
	if (values.every((value) => value === undefined)) return undefined;
	if (values.some((value) => typeof value !== "string" || !value.trim()))
		throw new Error(
			"Native mesh requires all three PRIME_AGENT_TEAM_MESH_URL, PRIME_AGENT_TEAM_MESH_TOKEN and PRIME_AGENT_TEAM_MACHINE_ID settings",
		);
	const [url, token, machineId] = values as [string, string, string];
	if (/[\u0000-\u001f\u007f]/.test(machineId) || Buffer.byteLength(machineId) > 128)
		throw new Error("Invalid native mesh machine ID");
	// Reuse the transport origin and token checks. Do not log or include values in errors.
	try {
		new NativeMeshTransport({ url, token });
	} catch {
		throw new Error("Invalid native mesh URL or token");
	}
	return { url, token, machineId };
}
