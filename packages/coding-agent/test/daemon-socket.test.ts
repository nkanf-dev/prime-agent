import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { describe, expect, it } from "vitest";
import {
	cleanupDaemonSocketPath,
	DaemonSocketPathLease,
	defaultDaemonSocketDir,
	defaultDaemonSocketPath,
	getDaemonSocketIdentity,
	normalizeSocketPath,
	prepareDaemonSocketPath,
} from "../src/modes/daemon/daemon-socket.js";

describe("normalizeSocketPath", () => {
	it("normalizes equivalent Unix spellings", () => {
		if (process.platform === "win32") return;
		expect(normalizeSocketPath("/a//b.sock/")).toBe("/a/b.sock");
	});
});

describe("defaultDaemonSocketPath", () => {
	it("uses a fixed Windows named pipe path", () => {
		if (process.platform !== "win32") {
			return;
		}

		expect(defaultDaemonSocketPath()).toBe("\\\\.\\pipe\\prime-agent-team-daemon");
	});

	it("uses a per-user Unix socket directory", () => {
		if (process.platform === "win32") {
			return;
		}

		const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
		const socketPath = defaultDaemonSocketPath();

		expect(dirname(socketPath)).toBe(join(tmpdir(), `prime-agent-team-${suffix}`));
		expect(basename(socketPath)).toBe("daemon.sock");
	});

	it("switches directories only when the longest worker path exceeds 103 UTF-8 bytes", () => {
		if (process.platform === "win32") {
			expect(defaultDaemonSocketPath()).toBe("\\\\.\\pipe\\prime-agent-team-daemon");
		} else {
			const original = process.env.TMPDIR;
			const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
			const worker = `worker-${"f".repeat(12)}-${"f".repeat(12)}.sock`;
			const base = "/tmp/";
			const fixed = Buffer.byteLength(join(base, `prime-agent-team-${suffix}`, worker));
			try {
				process.env.TMPDIR = base + "x".repeat(102 - fixed);
				const preferred = join(process.env.TMPDIR, `prime-agent-team-${suffix}`);
				expect(Buffer.byteLength(join(preferred, worker))).toBe(103);
				expect(defaultDaemonSocketDir()).toBe(preferred);
				process.env.TMPDIR += "é";
				expect(defaultDaemonSocketDir()).not.toBe(join(process.env.TMPDIR, `prime-agent-team-${suffix}`));
				expect(Buffer.byteLength(join(defaultDaemonSocketDir(), worker))).toBeLessThanOrEqual(103);
			} finally {
				if (original === undefined) delete process.env.TMPDIR;
				else process.env.TMPDIR = original;
			}
		}
	});

	it("uses a short private per-user directory when TMPDIR cannot fit a worker socket", async () => {
		if (process.platform === "win32") {
			expect(defaultDaemonSocketPath()).toBe("\\\\.\\pipe\\prime-agent-team-daemon");
		} else {
			const original = process.env.TMPDIR;
			const unique = mkdtempSync("/tmp/pa-long-");
			process.env.TMPDIR = join(unique, "界".repeat(40));
			const directory = defaultDaemonSocketDir();
			let created = false;
			try {
				expect(directory).toBe(defaultDaemonSocketDir());
				expect(directory).toMatch(/^\/tmp\/prime-agent-team-/);
				expect(
					Buffer.byteLength(join(directory, `worker-${"f".repeat(12)}-${"f".repeat(12)}.sock`)),
				).toBeLessThanOrEqual(103);
				expect(existsSync(directory)).toBe(false);
				await prepareDaemonSocketPath(join(directory, "daemon.sock"));
				created = true;
				expect(lstatSync(directory).mode & 0o777).toBe(0o700);
				chmodSync(directory, 0o755);
				await prepareDaemonSocketPath(join(directory, "daemon.sock"));
				expect(lstatSync(directory).mode & 0o777).toBe(0o700);
				process.env.TMPDIR += "different";
				expect(defaultDaemonSocketDir()).not.toBe(directory);
			} finally {
				if (original === undefined) delete process.env.TMPDIR;
				else process.env.TMPDIR = original;
				if (created) rmSync(directory, { recursive: true, force: true });
				rmSync(unique, { recursive: true, force: true });
			}
		}
	});

	it("rejects a symlink at the fallback directory without changing its target", async () => {
		if (process.platform === "win32") {
			expect(defaultDaemonSocketPath()).toBe("\\\\.\\pipe\\prime-agent-team-daemon");
		} else {
			const original = process.env.TMPDIR;
			const unique = mkdtempSync("/tmp/pa-link-");
			process.env.TMPDIR = join(unique, "x".repeat(120));
			const directory = defaultDaemonSocketDir();
			const target = join(unique, "target");
			let linked = false;
			try {
				mkdirSync(target, { mode: 0o755 });
				chmodSync(target, 0o755);
				expect(existsSync(directory)).toBe(false);
				symlinkSync(target, directory);
				linked = true;
				await expect(prepareDaemonSocketPath(join(directory, "daemon.sock"))).rejects.toThrow(/not a directory/);
				expect(lstatSync(target).mode & 0o777).toBe(0o755);
			} finally {
				if (original === undefined) delete process.env.TMPDIR;
				else process.env.TMPDIR = original;
				if (linked) unlinkSync(directory);
				rmSync(unique, { recursive: true, force: true });
			}
		}
	});

	it("isolates users and rejects a fallback directory owned by a different UID", async () => {
		if (process.platform === "win32") {
			expect(defaultDaemonSocketPath()).toBe("\\\\.\\pipe\\prime-agent-team-daemon");
		} else {
			const originalTmp = process.env.TMPDIR;
			const originalUid = Object.getOwnPropertyDescriptor(process, "getuid")!;
			const unique = mkdtempSync("/tmp/pa-owner-");
			let directory = "";
			let created = false;
			try {
				process.env.TMPDIR = join(unique, "x".repeat(120));
				const current = defaultDaemonSocketDir();
				const uid = process.getuid!();
				Object.defineProperty(process, "getuid", { ...originalUid, value: () => uid + 1 });
				directory = defaultDaemonSocketDir();
				expect(directory).not.toBe(current);
				expect(existsSync(directory)).toBe(false);
				mkdirSync(directory, { mode: 0o700 });
				created = true;
				await expect(prepareDaemonSocketPath(join(directory, "daemon.sock"))).rejects.toThrow(
					/not owned by the current user/,
				);
			} finally {
				Object.defineProperty(process, "getuid", originalUid);
				if (originalTmp === undefined) delete process.env.TMPDIR;
				else process.env.TMPDIR = originalTmp;
				if (created) rmSync(directory, { recursive: true, force: true });
				rmSync(unique, { recursive: true, force: true });
			}
		}
	});

	it("rejects an explicitly selected overlong socket instead of relocating it", async () => {
		if (process.platform === "win32") {
			expect(defaultDaemonSocketPath()).toBe("\\\\.\\pipe\\prime-agent-team-daemon");
		} else {
			const path = `/tmp/${"界".repeat(40)}.sock`;
			await expect(prepareDaemonSocketPath(path)).rejects.toThrow(/socket path is too long/i);
			expect(existsSync(path)).toBe(false);
		}
	});

	it("checks a live daemon before acquiring the socket path lock", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-live-"));
		const socketPath = join(dir, "daemon.sock");
		let observedLock: boolean | undefined;
		const server = createServer((socket) => {
			observedLock = existsSync(`${socketPath}.lock`);
			socket.destroy();
		});
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});

			await expect(prepareDaemonSocketPath(socketPath)).rejects.toThrow(/socket already in use/i);
			expect(observedLock).toBe(false);
		} finally {
			if (server.listening) {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not wait on a stale lock when no socket path exists", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-stale-lock-"));
		const socketPath = join(dir, "daemon.sock");
		mkdirSync(`${socketPath}.lock`);
		let prepared = false;
		try {
			await Promise.race([
				prepareDaemonSocketPath(socketPath).then(() => {
					prepared = true;
				}),
				new Promise<void>((resolve) => setTimeout(resolve, 250)),
			]);
			expect(prepared).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not unlink a replacement daemon's socket during delayed cleanup", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-ownership-"));
		const socketPath = join(dir, "daemon.sock");
		const oldServer = createServer();
		const replacementServer = createServer();
		try {
			await new Promise<void>((resolve, reject) => {
				oldServer.once("error", reject);
				oldServer.listen(socketPath, resolve);
			});
			const oldIdentity = getDaemonSocketIdentity(socketPath);
			if (!oldIdentity) {
				throw new Error("Expected a Unix daemon socket identity");
			}

			unlinkSync(socketPath);
			await new Promise<void>((resolve, reject) => {
				replacementServer.once("error", reject);
				replacementServer.listen(socketPath, resolve);
			});

			cleanupDaemonSocketPath(socketPath, oldIdentity);

			await expect(
				new Promise<void>((resolve, reject) => {
					const client = createConnection(socketPath);
					client.once("connect", () => {
						client.destroy();
						resolve();
					});
					client.once("error", reject);
				}),
			).resolves.toBeUndefined();
		} finally {
			await Promise.all(
				[oldServer, replacementServer].map(
					(server) =>
						new Promise<void>((resolve) => {
							server.close(() => resolve());
						}),
				),
			);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not unlink a socket while another daemon owns the path lock", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-lock-"));
		const socketPath = join(dir, "daemon.sock");
		const server = createServer();
		let releaseLock: (() => Promise<void>) | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});
			const identity = getDaemonSocketIdentity(socketPath);
			if (!identity) {
				throw new Error("Expected a Unix daemon socket identity");
			}
			releaseLock = await lockfile.lock(socketPath, { realpath: false });

			cleanupDaemonSocketPath(socketPath, identity);

			await expect(
				new Promise<void>((resolve, reject) => {
					const client = createConnection(socketPath);
					client.once("connect", () => {
						client.destroy();
						resolve();
					});
					client.once("error", reject);
				}),
			).resolves.toBeUndefined();
		} finally {
			await releaseLock?.();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not remove a replacement socket that appears while stale cleanup is pending", async () => {
		if (process.platform === "win32") {
			return;
		}

		const dir = mkdtempSync(join(tmpdir(), "pa-socket-startup-"));
		const socketPath = join(dir, "daemon.sock");
		const staleOwner = spawn(
			process.execPath,
			[
				"-e",
				"const { createServer } = require('node:net'); const server = createServer(); server.listen(process.argv[1], () => process.stdout.write('ready'));",
				socketPath,
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		const replacementServer = createServer();
		let replacementTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				staleOwner.stdout?.once("data", () => resolve());
				staleOwner.once("error", reject);
				staleOwner.once("exit", (code) => {
					if (code !== null && code !== 0) {
						reject(new Error(`Stale socket owner exited before listening: ${code}`));
					}
				});
			});
			staleOwner.kill("SIGKILL");
			await new Promise<void>((resolve) => staleOwner.once("close", () => resolve()));
			expect(existsSync(socketPath)).toBe(true);

			const replacementListening = new Promise<void>((resolve, reject) => {
				replacementTimer = setTimeout(() => {
					try {
						if (existsSync(socketPath)) {
							unlinkSync(socketPath);
						}
						replacementServer.once("error", reject);
						replacementServer.listen(socketPath, resolve);
					} catch (error) {
						reject(error);
					}
				}, 50);
			});

			await expect(prepareDaemonSocketPath(socketPath)).rejects.toThrow(
				/socket (already in use|changed ownership)/i,
			);
			await replacementListening;
			await expect(
				new Promise<void>((resolve, reject) => {
					const client = createConnection(socketPath);
					client.once("connect", () => {
						client.destroy();
						resolve();
					});
					client.once("error", reject);
				}),
			).resolves.toBeUndefined();
		} finally {
			if (replacementTimer) {
				clearTimeout(replacementTimer);
			}
			if (staleOwner.exitCode === null && staleOwner.signalCode === null) {
				staleOwner.kill("SIGKILL");
			}
			if (replacementServer.listening) {
				await new Promise<void>((resolve) => replacementServer.close(() => resolve()));
			}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe.skipIf(process.platform === "win32")("DaemonSocketPathLease compromise hardening", () => {
	it("records compromise without rethrowing listener failures", () => {
		const lease = new DaemonSocketPathLease("/tmp/test.sock", () => Promise.resolve());
		const observed: Error[] = [];
		lease.onCompromised(() => {
			throw new Error("listener failed");
		});
		lease.onCompromised((error) => observed.push(error));

		expect(() => lease.recordCompromise(new Error("lock update failed"))).not.toThrow();
		expect(lease.compromise?.message).toBe("lock update failed");
		expect(observed).toHaveLength(1);
	});

	it("does not unlink a successor socket after the old lease is compromised", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-socket-compromise-"));
		const socketPath = join(dir, "daemon.sock");
		const server = createServer();
		try {
			await new Promise<void>((resolve) => server.listen(socketPath, resolve));
			const identity = getDaemonSocketIdentity(socketPath);
			const lease = new DaemonSocketPathLease(socketPath, () => Promise.resolve());
			lease.recordCompromise(new Error("lock stolen"));

			cleanupDaemonSocketPath(socketPath, identity, lease);
			expect(existsSync(socketPath)).toBe(true);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
