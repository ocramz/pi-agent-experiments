// The git guardrail classifier: what is blocked, what is let through, and why
// the shell has to be parsed rather than grepped.

import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, segments, stripWrappers } from "../src/hooks/guardrails.ts";

const BLOCKED: [string, string][] = [
	["git reset --hard", "reset --hard"],
	["git reset --hard HEAD~1", "reset --hard"],
	["cd sub && git reset --hard", "reset --hard"],
	["git status; git reset --hard origin/main", "reset --hard"],
	["sudo git clean -fdx", "clean -f"],
	["git clean --force", "clean -f"],
	["git clean -xdf", "clean -f"],
	["/usr/bin/git reset --hard", "reset --hard"],
	["git -C sub reset --hard", "reset --hard"],
	["git -c core.pager=cat reset --hard", "reset --hard"],
	["GIT_DIR=.git git reset --hard", "reset --hard"],
	["env -u FOO GIT_X=1 git clean -f", "clean -f"],
	["git checkout .", "checkout ."],
	["git checkout -- .", "checkout ."],
	["git checkout HEAD -- :/", "checkout ."],
	["git checkout main :(top)", "checkout ."],
	["git checkout --pathspec-from-file=list.txt", "checkout --pathspec-from-file"],
	["git checkout -f main", "checkout -f <branch>"],
	["git checkout --force -q main", "checkout -f <branch>"],
	["git checkout -p", "checkout -p"],
	["git restore .", "restore ."],
	["git restore --worktree -- .", "restore ."],
	["git restore -SW Main.lean", "restore -SW"],
	["git restore --staged --worktree Main.lean", "restore -SW"],
	["git switch -f main", "switch --discard-changes"],
	["git switch --discard-changes main", "switch --discard-changes"],
	["git push --force", "push --force"],
	["git push -fu origin main", "push --force"],
	["git push --force-with-lease", "push --force"],
	["git push --mirror origin", "push --mirror"],
	["git push origin --delete feature", "push --delete"],
	["git push origin :feature", "push :ref"],
	["git push origin +main", "push +refspec"],
	["bash -c 'git reset --hard'", "reset --hard"],
	["sh -lc \"cd x && git clean -fd\"", "clean -f"],
	["echo $(git reset --hard)", "reset --hard"],
	["echo `git clean -f`", "clean -f"],
	["bash <<EOF\ngit reset --hard\nEOF", "reset --hard"],
	["true &&\\\n  git reset --hard", "reset --hard"],
	["eval git reset --hard", "reset --hard"],
];

const ALLOWED = [
	"git status",
	"git diff --stat",
	"git add Main.lean && git commit -m 'checkpoint(lean4): fill sorry'",
	'git commit -m "do not git reset --hard"',
	"echo 'git reset --hard'",
	"echo git reset --hard",
	"git reset --soft HEAD~1",
	"git reset Main.lean",
	"git clean -n",
	"git clean --dry-run",
	"git restore --staged .",
	"git restore --staged Main.lean",
	"git restore Main.lean",
	"git checkout -b new-branch",
	"git checkout main",
	"git checkout -- Main.lean",
	"git checkout -f -- Main.lean",
	"git switch main",
	"git switch -c feature",
	"git switch --force-create feature",
	"git push",
	"git push origin main",
	"git push --dry-run --force",
	"git stash push -m wip",
	"cat <<EOF\ngit reset --hard\nEOF",
	"lake build # then git reset --hard if it fails",
	"rg 'git clean -f' docs/",
];

for (const [cmd, rule] of BLOCKED) {
	test(`blocks: ${JSON.stringify(cmd)}`, () => {
		const v = classify(cmd);
		assert.equal(v.blocked, true, `${cmd} was let through`);
		assert.equal(v.rule, rule);
		assert.ok(v.reason);
	});
}

for (const cmd of ALLOWED) {
	test(`allows: ${JSON.stringify(cmd)}`, () => {
		const v = classify(cmd);
		assert.equal(v.blocked, false, `${cmd} was blocked as ${v.rule}`);
	});
}

test("G1: segments split on unquoted operators only", () => {
	const s = segments("a 'b && c' && d | e; f\ng");
	assert.deepEqual(
		s.map((x) => x.words),
		[["a", "b && c"], ["d"], ["e"], ["f"], ["g"]],
	);
});

test("G2: wrappers are stripped down to the program", () => {
	assert.deepEqual(stripWrappers(["sudo", "-u", "me", "env", "A=1", "nohup", "git", "status"]), ["git", "status"]);
});

test("G3: unbalanced quotes fall back to word matching, which only over-blocks", () => {
	assert.equal(classify("git reset --hard 'oops").blocked, true);
	assert.equal(classify("echo 'unterminated").blocked, false);
});

test("G4: subshells are commands; parentheses inside a word are not", () => {
	assert.equal(classify("(cd sub && git reset --hard)").blocked, true);
	assert.equal(classify("git log --format='%h (%s)'").blocked, false);
});
