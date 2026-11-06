import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";

const names = ["envinhands-agent-messaging", "envinhands-resources"];
const tempDirs: string[] = [];
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "team-skills-"));
	tempDirs.push(dir);
	const cwd = join(dir, "project");
	const agentDir = join(dir, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	return { cwd, agentDir };
}
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("team bundled skills", () => {
	it("discovers both from default bundled resources outside the checkout", async () => {
		const loader = new DefaultResourceLoader(fixture());
		await loader.reload();
		const skills = loader.getSkills().skills;
		for (const name of names) {
			const matches = skills.filter((s) => s.name === name);
			expect(matches).toHaveLength(1);
			expect(readFileSync(matches[0].filePath, "utf8")).toContain(`name: ${name}`);
		}
	});
	it("does not override or write a same-named user skill", async () => {
		const paths = fixture();
		const dir = join(paths.agentDir, "skills", names[0]);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "SKILL.md");
		const contents = `---\nname: ${names[0]}\ndescription: User-owned skill\n---\nUser content\n`;
		writeFileSync(file, contents);
		const loader = new DefaultResourceLoader(paths);
		await loader.reload();
		expect(loader.getSkills().skills.find((s) => s.name === names[0])?.filePath).toBe(file);
		expect(readFileSync(file, "utf8")).toBe(contents);
		expect(loader.getSkills().diagnostics.some((d) => d.type === "collision" && d.collision?.name === names[0])).toBe(
			true,
		);
	});
	it("respects noSkills", async () => {
		const loader = new DefaultResourceLoader({ ...fixture(), noSkills: true });
		await loader.reload();
		expect(loader.getSkills().skills.filter((s) => names.includes(s.name))).toEqual([]);
	});
});
