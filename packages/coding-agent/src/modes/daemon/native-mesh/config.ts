import { readTeamMeshConfig } from "./team-config.js";
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
	let config: unknown;
	if (values.some((value) => value !== undefined)) {
		if (values.some((value) => typeof value !== "string" || !value.trim()))
			throw new Error(
				"Native mesh requires all three PRIME_AGENT_TEAM_MESH_URL, PRIME_AGENT_TEAM_MESH_TOKEN and PRIME_AGENT_TEAM_MACHINE_ID settings; remove all three to use the Team config file",
			);
		const [url, token, machineId] = values;
		config = { url, token, machineId };
	} else {
		config = readTeamMeshConfig(env);
		if (config === undefined) return undefined;
	}
	if (!config || typeof config !== "object" || Array.isArray(config))
		throw new Error("Native mesh config must be a JSON object with non-empty url, token and machineId fields");
	const { url, token, machineId } = config as Record<string, unknown>;
	if ([url, token, machineId].some((value) => typeof value !== "string" || !value.trim()))
		throw new Error("Native mesh config requires non-empty url, token and machineId fields");
	const parsed = { url: url as string, token: token as string, machineId: machineId as string };
	if (/[\u0000-\u001f\u007f]/.test(parsed.machineId) || Buffer.byteLength(parsed.machineId) > 128)
		throw new Error("Invalid native mesh machine ID");
	// Reuse the transport origin and token checks. Do not log or include values in errors.
	try {
		new NativeMeshTransport({ url: parsed.url, token: parsed.token });
	} catch {
		throw new Error("Invalid native mesh URL or token");
	}
	return parsed;
}
