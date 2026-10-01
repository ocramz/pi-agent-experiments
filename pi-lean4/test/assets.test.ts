// The skills, references and prompt templates, checked the way pi will load
// them and against the runtime they describe — no model, no Lean.
//
// The checks that matter most: every lean_* tool and op a skill tells the
// model to use exists (TOOL_ENUMS is the runtime's own contract); every link
// resolves to a file that ships; nothing of the upstream Claude-specific
// machinery survived the port; and every git command a skill suggests is one
// the guardrails let through.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, matchesGlob, relative, resolve } from "node:path";
import { test } from "node:test";
import { classify } from "../src/hooks/guardrails.ts";
import { COMMAND, TOOL_ENUMS, TOOL_NAMES } from "../src/tools.ts";

const PKG = resolve(import.meta.dirname, "..");
const SKILLS = join(PKG, "skills");
const PROMPTS = join(PKG, "prompts");
const manifest = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { files: string[] };

const skillDirs = readdirSync(SKILLS).filter((d) => statSync(join(SKILLS, d)).isDirectory());
const skillFiles = skillDirs.map((d) => join(SKILLS, d, "SKILL.md"));
const refDir = join(SKILLS, "lean4", "references");
const refFiles = readdirSync(refDir).map((f) => join(refDir, f));
const templates = readdirSync(PROMPTS).map((f) => join(PROMPTS, f));
const allMd = [...skillFiles, ...refFiles];

const rel = (p: string) => relative(PKG, p);
const stripComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");
/** Text outside fenced code blocks, line numbers kept. */
const prose = (s: string) => {
	let fenced = false;
	return s
		.split("\n")
		.map((l) => {
			if (/^\s*(```|~~~)/.test(l)) {
				fenced = !fenced;
				return "";
			}
			return fenced ? "" : l;
		})
		.join("\n");
};

function frontmatter(path: string): Record<string, string> {
	const text = readFileSync(path, "utf8");
	assert.ok(text.startsWith("---\n"), `${rel(path)}: frontmatter must start at byte 0`);
	const end = text.indexOf("\n---\n", 4);
	assert.ok(end > 0, `${rel(path)}: unterminated frontmatter`);
	const out: Record<string, string> = {};
	for (const line of text.slice(4, end).split("\n")) {
		// Free text is double-quoted (an unquoted ": " breaks YAML); a bare token
		// such as a skill name need not be.
		const m = /^([a-z-]+):\s*(?:"((?:[^"\\]|\\.)*)"|([a-z0-9-]+))\s*$/.exec(line);
		assert.ok(m, `${rel(path)}: frontmatter line is not key: "value" — ${line}`);
		out[m[1]] = m[2] ?? m[3];
	}
	return out;
}

const slug = (h: string) =>
	h
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/\s/g, "-");

/** GitHub's heading anchors: a repeated slug gets -1, -2, … */
function anchors(path: string): Set<string> {
	const out = new Set<string>();
	const seen = new Map<string, number>();
	for (const line of prose(readFileSync(path, "utf8")).split("\n")) {
		const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
		if (!m) continue;
		const s = slug(m[1]);
		const n = seen.get(s) ?? 0;
		seen.set(s, n + 1);
		out.add(n === 0 ? s : `${s}-${n}`);
	}
	return out;
}

function links(path: string): { target: string; anchor?: string; line: number }[] {
	const out: { target: string; anchor?: string; line: number }[] = [];
	prose(stripComments(readFileSync(path, "utf8")))
		.split("\n")
		.forEach((l, i) => {
			for (const m of l.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
				const url = m[1];
				if (/^[a-z]+:/.test(url)) continue;
				const [target, anchor] = url.split("#");
				out.push({ target, anchor, line: i + 1 });
			}
		});
	return out;
}

test("SK1: skills/ holds exactly the six skill directories, each with a SKILL.md", () => {
	assert.deepEqual(skillDirs.sort(), ["lean4", "lean4-formalize", "lean4-golf", "lean4-prove", "lean4-repair", "lean4-review"]);
	for (const f of skillFiles) assert.ok(existsSync(f), rel(f));
	assert.deepEqual(
		readdirSync(SKILLS).filter((f) => f.endsWith(".md")),
		[],
		"a .md directly in skills/ would load as a skill of its own",
	);
	assert.ok(!refFiles.some((f) => f.endsWith("SKILL.md")));
});

test("SK2: frontmatter follows pi's rules; names match directories; descriptions are distinct", () => {
	const seen = new Set<string>();
	for (const f of skillFiles) {
		const fm = frontmatter(f);
		assert.equal(fm.name, dirname(f).split("/").pop(), rel(f));
		assert.match(fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
		assert.ok(fm.name.length <= 64);
		assert.ok(fm.description && fm.description.length <= 1024, `${rel(f)}: description length ${fm.description?.length}`);
		assert.ok(!seen.has(fm.description));
		seen.add(fm.description);
	}
});

test("SK3: a SKILL.md stays short enough to read in full", () => {
	for (const f of skillFiles) {
		const n = readFileSync(f, "utf8").split("\n").length;
		assert.ok(n <= 250, `${rel(f)} has ${n} lines`);
	}
});

test("SK4: every relative link resolves, ships, and lands on a real heading", () => {
	for (const f of allMd) {
		for (const l of links(f)) {
			const target = l.target ? resolve(dirname(f), l.target) : f;
			assert.ok(existsSync(target), `${rel(f)}:${l.line} links to missing ${l.target}`);
			if (target.endsWith(".md")) {
				assert.ok(
					manifest.files.some((g) => matchesGlob(rel(target), g)),
					`${rel(f)}:${l.line} links to ${rel(target)}, which package.json's files does not ship`,
				);
			}
			if (l.anchor) assert.ok(anchors(target).has(l.anchor), `${rel(f)}:${l.line}: no heading #${l.anchor} in ${rel(target)}`);
		}
	}
});

test("SK5: upstream links are pinned to a commit, never to main", () => {
	for (const f of allMd) {
		const text = stripComments(readFileSync(f, "utf8"));
		assert.ok(!text.includes("/blob/main/"), rel(f));
		for (const m of text.matchAll(/github\.com\/cameronfreer\/lean4-skills\/blob\/([^/]+)\//g)) {
			assert.equal(m[1], "b6243b85b9b0a0ddff5bb6773889044daf687f8e", `${rel(f)}: ${m[0]}`);
		}
	}
});

test("SK6: every reference is reachable from a skill", () => {
	const reached = new Set<string>();
	const queue = [...skillFiles];
	while (queue.length) {
		const f = queue.shift()!;
		for (const l of links(f)) {
			if (!l.target) continue;
			const t = resolve(dirname(f), l.target);
			if (t.endsWith(".md") && !reached.has(t)) {
				reached.add(t);
				queue.push(t);
			}
		}
	}
	for (const r of refFiles) assert.ok(reached.has(r), `${rel(r)} is not linked from any skill`);
});

const FORBIDDEN: RegExp[] = [
	/mcp__/,
	/\$LEAN4_/,
	/LEAN4_[A-Z]/,
	/CLAUDE_/,
	/\bClaude\b/,
	/\bCodex\b/,
	/\/lean4:/,
	/lean4-skills-/,
	/sorry_analyzer|check_axioms_inline|smart_search|search_mathlib|find_golfable|find_exact_candidates|analyze_let_usage|solver_cascade|try_exact_at_step|parse_lean_errors/,
	/cycle[-_]tracker/,
	/lean_state_search/,
	/sub-?agent/i,
	/Task tool/,
	/run-contract|run-store/,
	/validated-invocation|UserPromptSubmit|SessionStart|hooks\.json/,
	/\b\d+\s*\/\s*30\s*s\b|\b\d+ per 30\b/,
];

test("SK7: none of the upstream machinery survived the port", () => {
	for (const f of [...allMd, ...templates]) {
		const text = stripComments(readFileSync(f, "utf8"));
		for (const re of FORBIDDEN) assert.doesNotMatch(text, re, `${rel(f)} contains ${re}`);
	}
});

test("SK8: every lean_* name and op the text uses exists in the runtime", () => {
	const allowed = new Set<string>([...TOOL_NAMES, "lean_lib", "lean_exe"]);
	for (const f of [...allMd, ...templates]) {
		const text = stripComments(readFileSync(f, "utf8"));
		for (const m of text.matchAll(/\blean_[a-z_]+\b/g)) assert.ok(allowed.has(m[0]), `${rel(f)} names ${m[0]}`);
		for (const m of text.matchAll(/\b(lean_[a-z_]+)\s*\{\s*(op|source|kind|severity):\s*"([^"]+)"/g)) {
			const values = TOOL_ENUMS[m[1] as keyof typeof TOOL_ENUMS]?.[m[2]];
			assert.ok(values, `${rel(f)}: ${m[1]} has no ${m[2]} parameter`);
			assert.ok(values.includes(m[3]), `${rel(f)}: ${m[1]} ${m[2]} "${m[3]}" is not one of ${values.join(", ")}`);
		}
	}
});

test("SK9: the ground-rules block is the same in all six skills", () => {
	const blocks = skillFiles.map((f) => {
		const m = /<!-- ground-rules:start -->([\s\S]*?)<!-- ground-rules:end -->/.exec(readFileSync(f, "utf8"));
		assert.ok(m, `${rel(f)} has no ground-rules block`);
		return m[1];
	});
	for (const b of blocks) assert.equal(b, blocks[0]);
});

test("SK10: the shipped notices carry both licences and list every skill and reference", () => {
	const notices = readFileSync(join(PKG, "THIRD_PARTY_NOTICES.md"), "utf8");
	assert.match(notices, /Copyright \(c\) 2025 Oliver Dressler/);
	assert.match(notices, /Copyright \(c\) 2025 Lean 4 Theorem Proving Skill Contributors/);
	assert.equal((notices.match(/Permission is hereby granted/g) ?? []).length, 2);
	assert.ok(manifest.files.includes("THIRD_PARTY_NOTICES.md"));
	for (const f of allMd) {
		assert.ok(notices.includes(`| ${rel(f)} |`), `${rel(f)} is missing from THIRD_PARTY_NOTICES.md`);
	}
	// Skills point at the notices from their frontmatter. Per-file comments are
	// not required: the model reads these files verbatim, so the attribution
	// lives once, in the shipped notices file, with its file map.
	for (const f of skillFiles) assert.match(frontmatter(f).license ?? "", /THIRD_PARTY_NOTICES\.md/, rel(f));
});

test("SK11: templates: named lean-*, described, and $ only in placeholders", () => {
	const skillNames = new Set(skillDirs);
	for (const f of templates) {
		const name = f.split("/").pop()!;
		assert.match(name, /^lean-[a-z]+\.md$/);
		assert.notEqual(name.replace(/\.md$/, ""), COMMAND, "a template named like the /lean command would be shadowed");
		const fm = frontmatter(f);
		assert.ok(fm.description && fm["argument-hint"], rel(f));
		const body = readFileSync(f, "utf8").split("\n---\n").slice(1).join("\n---\n");
		const stray = body.replace(/\$\{@:-[^}]*\}|\$@|\$ARGUMENTS|\$\{\d+:-[^}]*\}|\$\d+/g, "");
		assert.ok(!stray.includes("$"), `${rel(f)} has a $ outside a placeholder`);
		const named = [...body.matchAll(/`(lean4[a-z-]*)`/g)].map((m) => m[1]);
		assert.ok(named.length > 0 && named.every((n) => skillNames.has(n)), `${rel(f)} must name an existing skill (${named})`);
		assert.ok(body.split("\n").length <= 40);
	}
});

test("SK12: every git command a skill suggests is one the guardrails allow", () => {
	for (const f of allMd) {
		let fenced = false;
		for (const line of readFileSync(f, "utf8").split("\n")) {
			if (/^\s*```/.test(line)) {
				fenced = !fenced;
				continue;
			}
			if (!fenced || !/^\s*git\s/.test(line)) continue;
			const v = classify(line.trim());
			assert.equal(v.blocked, false, `${rel(f)} suggests \`${line.trim()}\`, which the guardrails block (${v.rule})`);
			assert.doesNotMatch(line, /git add (-A|\.)(\s|$)/, rel(f));
		}
	}
});
