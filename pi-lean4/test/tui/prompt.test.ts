// What the model is *told*: the Available-tools lines, the guidelines, the
// tool schemas, and the skills block — all assembled before the first call,
// none of it visible in any message. Free and deterministic (faux model).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { SEARCH_SOURCES, TOOL_NAMES } from "../../src/tools.ts";
import { PKG, type Recorded, session } from "./session.ts";

const DONE = "SCRIPT-COMPLETE";
const SNAPSHOT = join(import.meta.dirname, "__snapshots__", "agent-prompt.txt");
const SKILLS = ["lean4", "lean4-formalize", "lean4-golf", "lean4-prove", "lean4-repair", "lean4-review"];

let cached: Recorded | null = null;
async function prompted(t: TestContext): Promise<Recorded> {
	if (cached) return cached;
	const s = await session(t, { faux: [{ text: DONE }] });
	await s.command("go");
	await s.expect(DONE, { timeout: 120_000 });
	await s.close();
	cached = s.turns()[0];
	return cached;
}

/** The extension's slice of the prompt: its tool lines and its guidelines. */
function ourSlice(prompt: string): string[] {
	return prompt.split("\n").filter((l) => /\blean_[a-z]+\b/.test(l) && /^- /.test(l));
}

test("P1: every tool has an Available-tools line, without stuttering its own name", async (t) => {
	const prompt = (await prompted(t)).systemPrompt ?? "";
	for (const name of TOOL_NAMES) {
		assert.match(prompt, new RegExp(`^- ${name}: \\S`, "m"), `${name} has no Available-tools line`);
		assert.doesNotMatch(prompt, new RegExp(`^- ${name}: ${name}\\b`, "m"));
	}
});

test("P2: twelve guidelines reach the model, each naming its tool", async (t) => {
	const prompt = (await prompted(t)).systemPrompt ?? "";
	const toolLines = new Set(TOOL_NAMES.map((n) => `- ${n}:`));
	const guidelines = ourSlice(prompt).filter((l) => ![...toolLines].some((p) => l.startsWith(p)));
	assert.equal(guidelines.length, 12, guidelines.join("\n"));
	for (const [rule, ...needles] of [
		["goal before each step", /lean_goal/, /never guess/],
		["auto-check after edits", /\[lean auto-check\]/, /lean_diagnostics/],
		["partial is not failure", /still elaborating/, /not a failure/],
		["try candidates before editing", /lean_attempt \{op: "tactics"/, /2-4 candidates/],
		["no scratch files", /lean_attempt \{op: "code"\}/, /scratch files/],
		["search before you prove", /lean_search \{source: "local"/],
		["never loop on a rate limit", /rate-limited/, /never retry/],
		["axioms before done", /lean_verify \{op: "axioms"/, /sorryAx/],
		["build rarely", /lean_build only/],
		["code actions are not applied", /lean_nav \{op: "code_actions"/, /without applying/],
		["golf candidates are only candidates", /lean_analyze \{op: "golf"\}/, /never change a theorem statement/],
	] as [string, ...RegExp[]][]) {
		assert.ok(guidelines.some((g) => needles.every((n) => n.test(g))), `no guideline carries "${rule}"\n${guidelines.join("\n")}`);
	}
});

test("P3: the six skills are offered, from this package, with their descriptions", async (t) => {
	const prompt = (await prompted(t)).systemPrompt ?? "";
	const block = /<available_skills>[\s\S]*<\/available_skills>/.exec(prompt)?.[0] ?? "";
	for (const name of SKILLS) {
		assert.match(block, new RegExp(`<name>${name}</name>`));
		assert.ok(block.includes(`<location>${join(PKG, "skills", name, "SKILL.md")}</location>`), `${name} location`);
	}
});

test("P4: enums are flat string enums, and only the op/source/path parameters are required", async (t) => {
	const tools = (await prompted(t)).tools ?? [];
	for (const name of TOOL_NAMES) {
		const tool = tools.find((x) => x.name === name);
		assert.ok(tool, `${name} was not sent`);
		const props = tool.parameters?.properties ?? {};
		for (const [k, v] of Object.entries(props)) {
			assert.ok(!("anyOf" in v) && !("oneOf" in v), `${name}.${k} is a union; providers mangle those`);
			assert.ok(typeof v.description === "string" && v.description.length > 0, `${name}.${k} has no description`);
		}
	}
	const search = tools.find((x) => x.name === "lean_search")!;
	assert.deepEqual(search.parameters?.properties?.source?.enum, [...SEARCH_SOURCES]);
	assert.deepEqual(search.parameters?.required, ["source"]);
	assert.deepEqual(tools.find((x) => x.name === "lean_goal")!.parameters?.required, ["path", "line"]);
});

test("P5: the extension's slice of the prompt matches the snapshot (PI_UPDATE_PROMPT=1 to re-record)", async (t) => {
	const slice = ourSlice((await prompted(t)).systemPrompt ?? "").join("\n") + "\n";
	if (process.env.PI_UPDATE_PROMPT || !existsSync(SNAPSHOT)) {
		mkdirSync(join(SNAPSHOT, ".."), { recursive: true });
		writeFileSync(SNAPSHOT, slice);
		if (!process.env.PI_UPDATE_PROMPT) assert.fail("no snapshot existed; one was recorded — commit it and re-run");
		return;
	}
	assert.equal(slice, readFileSync(SNAPSHOT, "utf8"), "the prompt changed: review the diff, then PI_UPDATE_PROMPT=1 to re-record");
});
