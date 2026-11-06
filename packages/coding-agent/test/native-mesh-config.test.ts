import { describe, expect, it } from "vitest";
import { nativeMeshConfigFromEnvironment } from "../src/modes/daemon/native-mesh/config.js";

describe("native mesh opt-in configuration", () => {
	it("is off by default and rejects partial or empty configuration", () => {
		expect(nativeMeshConfigFromEnvironment({})).toBeUndefined();
		expect(() => nativeMeshConfigFromEnvironment({ PRIME_AGENT_TEAM_MESH_URL: "http://127.0.0.1:123" })).toThrow(
			"all three",
		);
		expect(() =>
			nativeMeshConfigFromEnvironment({
				PRIME_AGENT_TEAM_MESH_URL: "",
				PRIME_AGENT_TEAM_MESH_TOKEN: "x",
				PRIME_AGENT_TEAM_MACHINE_ID: "host",
			}),
		).toThrow("all three");
	});
	it("allows loopback plaintext or remote TLS only, and never discloses invalid inputs", () => {
		const env = {
			PRIME_AGENT_TEAM_MESH_URL: "http://127.0.0.1:123",
			PRIME_AGENT_TEAM_MESH_TOKEN: "secret",
			PRIME_AGENT_TEAM_MACHINE_ID: "host",
		};
		expect(nativeMeshConfigFromEnvironment(env)).toEqual({
			url: env.PRIME_AGENT_TEAM_MESH_URL,
			token: "secret",
			machineId: "host",
		});
		expect(() =>
			nativeMeshConfigFromEnvironment({ ...env, PRIME_AGENT_TEAM_MESH_URL: "http://secret.example" }),
		).toThrow("Invalid native mesh URL or token");
		expect(
			nativeMeshConfigFromEnvironment({ ...env, PRIME_AGENT_TEAM_MESH_URL: "https://example.com" }),
		).toBeDefined();
		expect(() => nativeMeshConfigFromEnvironment({ ...env, PRIME_AGENT_TEAM_MACHINE_ID: "x\ny" })).toThrow(
			"machine ID",
		);
	});
});
