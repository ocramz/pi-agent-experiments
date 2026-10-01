/**
 * Git guardrails: refuse the commands that destroy uncommitted proof work.
 *
 * The rule set is lean4-skills' hooks/guardrails.sh (MIT, © 2025 Lean 4
 * Theorem Proving Skill Contributors) — its hard blocks only: whole-worktree
 * discards (`reset --hard`, `clean -f`, `checkout .`, `restore .`, forced
 * checkout/switch) and history-rewriting pushes. The soft gates there
 * (ask before `push`, `commit --amend`) are pi's own approval business.
 *
 * Rather than regexes over the raw string, the command is tokenised the way a
 * shell would split it — quotes, `&& || ; | &`, newlines, `$( )`, backticks,
 * `bash -c '…'`, heredocs fed to a shell — and the rules match on the git
 * argument vector. That is what lets `git commit -m "reset --hard"` and
 * `cat <<EOF … git reset --hard … EOF` through while `cd x && git reset --hard`
 * and `bash -c 'git clean -fdx'` are caught.
 *
 * There is no bypass token. A model that wants to discard work asks the human,
 * who can run the command themselves or turn the guardrails off.
 */

export interface Verdict {
	blocked: boolean;
	rule?: string;
	reason?: string;
	command?: string;
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const WHOLE_TREE = new Set([".", "./", ":/", ":(top)", "*"]);

interface Segment {
	words: string[];
	/** Commands found nested in this segment ($(…), `…`, sh -c, heredoc to a shell). */
	nested: string[];
}

/** Split a command line into simple-command segments. Throws on unbalanced quotes. */
export function segments(input: string): Segment[] {
	const out: Segment[] = [];
	let words: string[] = [];
	let nested: string[] = [];
	let word = "";
	let inWord = false;
	let pendingHeredoc: { delim: string; strip: boolean } | null = null;
	let heredocForShell = false;
	const endWord = () => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	const endSegment = () => {
		endWord();
		if (words.length || nested.length) out.push({ words, nested });
		words = [];
		nested = [];
	};
	const readBalanced = (i: number, open: string, close: string): [string, number] => {
		let depth = 1;
		let j = i;
		let quote: string | null = null;
		for (; j < input.length; j++) {
			const c = input[j];
			if (quote) {
				if (c === "\\" && quote === '"') j++;
				else if (c === quote) quote = null;
				continue;
			}
			if (c === "'" || c === '"') quote = c;
			else if (c === "\\") j++;
			else if (c === open) depth++;
			else if (c === close && --depth === 0) return [input.slice(i, j), j];
		}
		throw new Error("unbalanced substitution");
	};

	for (let i = 0; i < input.length; i++) {
		const c = input[i];
		if (c === "\\") {
			if (input[i + 1] === "\n") {
				i++;
				continue;
			}
			word += input[i + 1] ?? "";
			inWord = true;
			i++;
			continue;
		}
		if (c === "'") {
			const end = input.indexOf("'", i + 1);
			if (end < 0) throw new Error("unbalanced single quote");
			word += input.slice(i + 1, end);
			inWord = true;
			i = end;
			continue;
		}
		if (c === '"') {
			let j = i + 1;
			let text = "";
			for (; j < input.length && input[j] !== '"'; j++) {
				if (input[j] === "\\" && j + 1 < input.length) {
					text += input[j + 1];
					j++;
				} else if (input[j] === "$" && input[j + 1] === "(") {
					const [inner, close] = readBalanced(j + 2, "(", ")");
					nested.push(inner);
					text += `$(${inner})`;
					j = close;
				} else if (input[j] === "`") {
					const close = input.indexOf("`", j + 1);
					if (close < 0) throw new Error("unbalanced backtick");
					nested.push(input.slice(j + 1, close));
					j = close;
				} else text += input[j];
			}
			if (j >= input.length) throw new Error("unbalanced double quote");
			word += text;
			inWord = true;
			i = j;
			continue;
		}
		if (c === "$" && input[i + 1] === "(") {
			const [inner, close] = readBalanced(i + 2, "(", ")");
			nested.push(inner);
			word += `$(${inner})`;
			inWord = true;
			i = close;
			continue;
		}
		if (c === "`") {
			const close = input.indexOf("`", i + 1);
			if (close < 0) throw new Error("unbalanced backtick");
			nested.push(input.slice(i + 1, close));
			i = close;
			inWord = true;
			continue;
		}
		if (c === "<" && input[i + 1] === "<" && input[i + 2] !== "<") {
			endWord();
			let j = i + 2;
			const strip = input[j] === "-";
			if (strip) j++;
			while (input[j] === " " || input[j] === "\t") j++;
			const m = /^(['"]?)([A-Za-z0-9_]+)\1/.exec(input.slice(j));
			if (m) {
				pendingHeredoc = { delim: m[2], strip };
				const cmd = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && w !== "sudo" && w !== "env" && w !== "command");
				heredocForShell = !!cmd && SHELLS.has(cmd.split("/").pop()!);
				i = j + m[0].length - 1;
				continue;
			}
		}
		if (c === "\n") {
			endSegment();
			if (pendingHeredoc) {
				// The body is data, not commands — unless it is fed to a shell.
				const body: string[] = [];
				let pos = i + 1;
				for (;;) {
					const end = input.indexOf("\n", pos);
					const line = input.slice(pos, end < 0 ? input.length : end);
					if ((pendingHeredoc.strip ? line.replace(/^\t+/, "") : line) === pendingHeredoc.delim) {
						i = (end < 0 ? input.length : end) - 1;
						break;
					}
					body.push(line);
					if (end < 0) {
						i = input.length;
						break;
					}
					pos = end + 1;
				}
				if (heredocForShell) out.push({ words: [], nested: [body.join("\n")] });
				pendingHeredoc = null;
			}
			continue;
		}
		// A parenthesis opens a subshell only where a word could start, and
		// closes one only if the word has no `(` of its own (`:(top)` is a word).
		if (c === "(" && inWord) {
			word += c;
			continue;
		}
		if (c === ")" && inWord && (word.match(/\(/g) ?? []).length > (word.match(/\)/g) ?? []).length) {
			word += c;
			continue;
		}
		if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
			endSegment();
			if ((c === "&" || c === "|") && input[i + 1] === c) i++;
			continue;
		}
		if (c === " " || c === "\t") {
			endWord();
			continue;
		}
		if (c === "#" && !inWord) {
			const nl = input.indexOf("\n", i);
			i = nl < 0 ? input.length : nl - 1;
			continue;
		}
		word += c;
		inWord = true;
	}
	endSegment();
	return out;
}

/** Drop wrappers that do not change which program runs: sudo, env, VAR=, command, nohup, time, exec. */
export function stripWrappers(words: readonly string[]): string[] {
	let w = [...words];
	for (;;) {
		const head = w[0];
		if (head === undefined) return w;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
			w = w.slice(1);
			continue;
		}
		const base = head.split("/").pop()!;
		if (base === "sudo" || base === "doas") {
			let i = 1;
			while (i < w.length && w[i].startsWith("-")) {
				if (/^-[ugCDhpRrt]$/.test(w[i])) i++;
				i++;
			}
			w = w.slice(i);
			continue;
		}
		if (base === "env") {
			let i = 1;
			while (i < w.length && (w[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]))) {
				if (w[i] === "-u" || w[i] === "-C" || w[i] === "-S") i++;
				i++;
			}
			w = w.slice(i);
			continue;
		}
		if (["command", "nohup", "time", "exec", "builtin", "nice"].includes(base)) {
			w = w.slice(1);
			while (w[0]?.startsWith("-")) w = w.slice(1);
			continue;
		}
		return w;
	}
}

/** `git [globals] sub args…` → [sub, args], or null if this is not git. */
export function gitArgv(words: readonly string[]): [string, string[]] | null {
	const w = stripWrappers(words);
	if (!w.length || w[0].split("/").pop() !== "git") return null;
	let i = 1;
	while (i < w.length && w[i].startsWith("-")) {
		if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"].includes(w[i])) i++;
		i++;
	}
	if (i >= w.length) return null;
	return [w[i], w.slice(i + 1)];
}

const shortHas = (a: string, letter: string) => /^-[A-Za-z]+$/.test(a) && a.includes(letter);
const positionals = (args: readonly string[]) => args.filter((a) => !a.startsWith("-"));
const pathLike = (a: string) => a.includes("/") || a.includes(".") || a.endsWith(".lean");

function rule(sub: string, args: readonly string[]): { rule: string; reason: string } | null {
	const dashdash = args.indexOf("--");
	const afterDD = dashdash >= 0 ? args.slice(dashdash + 1) : [];
	switch (sub) {
		case "reset":
			if (args.includes("--hard")) return { rule: "reset --hard", reason: "git reset --hard discards every uncommitted change" };
			if (args.includes("--merge") || args.includes("--keep")) return null;
			return null;
		case "clean":
			if (args.some((a) => a === "--force" || shortHas(a, "f"))) {
				return { rule: "clean -f", reason: "git clean -f deletes untracked files, which nothing can recover" };
			}
			return null;
		case "checkout": {
			const all = dashdash >= 0 ? [...args.slice(0, dashdash), ...afterDD] : args;
			if (all.some((a) => WHOLE_TREE.has(a))) return { rule: "checkout .", reason: "a whole-worktree git checkout discards all changes" };
			if (args.some((a) => a === "--pathspec-from-file" || a.startsWith("--pathspec-from-file="))) {
				return { rule: "checkout --pathspec-from-file", reason: "git checkout --pathspec-from-file reads paths the guardrail cannot inspect" };
			}
			const before = dashdash >= 0 ? args.slice(0, dashdash) : args;
			const pos = positionals(before);
			if (before.some((a) => a === "-p" || a === "--patch" || shortHas(a, "p")) && dashdash < 0 && !pos.some(pathLike)) {
				return { rule: "checkout -p", reason: "git checkout -p without a path sweeps the whole worktree" };
			}
			const force = before.some((a) => a === "--force" || shortHas(a, "f"));
			if (force && dashdash < 0 && pos.length > 0 && !pos.some(pathLike)) {
				return { rule: "checkout -f <branch>", reason: "a forced branch checkout discards uncommitted edits across the worktree" };
			}
			return null;
		}
		case "restore": {
			const staged = args.some((a) => a === "--staged" || a.startsWith("--staged=") || shortHas(a, "S"));
			const worktree = args.some((a) => a === "--worktree" || a.startsWith("--worktree=") || shortHas(a, "W"));
			if (staged && !worktree) return null; // unstaging only
			if (args.some((a) => a === "--pathspec-from-file" || a.startsWith("--pathspec-from-file="))) {
				return { rule: "restore --pathspec-from-file", reason: "git restore --pathspec-from-file reads paths the guardrail cannot inspect" };
			}
			if (staged && worktree) return { rule: "restore -SW", reason: "git restore --staged --worktree resets both the index and the worktree" };
			const all = dashdash >= 0 ? [...args.slice(0, dashdash), ...afterDD] : args;
			if (all.some((a) => WHOLE_TREE.has(a))) return { rule: "restore .", reason: "git restore on the whole worktree discards all changes" };
			return null;
		}
		case "switch":
			if (args.some((a) => a === "-f" || a === "--force" || a === "--discard-changes")) {
				return { rule: "switch --discard-changes", reason: "git switch --force/--discard-changes throws away uncommitted edits" };
			}
			return null;
		case "push": {
			if (args.includes("--dry-run") || args.includes("-n")) return null;
			if (args.some((a) => a === "--force" || a.startsWith("--force-with-lease") || a.startsWith("--force-if-includes") || shortHas(a, "f"))) {
				return { rule: "push --force", reason: "a forced push rewrites shared history" };
			}
			if (args.includes("--mirror")) return { rule: "push --mirror", reason: "git push --mirror deletes remote refs not present locally" };
			if (args.some((a) => a === "--delete" || shortHas(a, "d"))) return { rule: "push --delete", reason: "git push --delete removes a remote ref" };
			const pos = positionals(args);
			if (pos.slice(1).some((a) => a.startsWith(":"))) return { rule: "push :ref", reason: "git push <remote> :<ref> deletes a remote ref" };
			if (pos.slice(1).some((a) => a.startsWith("+"))) return { rule: "push +refspec", reason: "a +refspec forces a non-fast-forward update of shared history" };
			return null;
		}
		default:
			return null;
	}
}

function check(command: string, depth: number): Verdict {
	let segs: Segment[];
	try {
		segs = segments(command);
	} catch {
		// Unparseable (unbalanced quotes): fall back to whitespace words, which
		// can only over-block, never let a destructive command through unseen.
		segs = command.split(/&&|\|\||;|\||\n/).map((s) => ({ words: s.trim().split(/\s+/).filter(Boolean), nested: [] }));
	}
	for (const s of segs) {
		const w = stripWrappers(s.words);
		const git = gitArgv(w);
		if (git) {
			const hit = rule(git[0], git[1]);
			if (hit) return { blocked: true, ...hit, command: w.join(" ") };
		}
		if (depth < 4) {
			const inner = [...s.nested];
			const cmd = w[0]?.split("/").pop();
			if (cmd && SHELLS.has(cmd)) {
				const c = w.findIndex((x, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(x));
				if (c > 0 && w[c + 1] !== undefined) inner.push(w[c + 1]);
			}
			if (cmd === "eval") inner.push(w.slice(1).join(" "));
			if (cmd === "xargs" && w.some((x) => x === "git" || x.endsWith("/git"))) inner.push(w.slice(w.findIndex((x) => x === "git" || x.endsWith("/git"))).join(" "));
			for (const n of inner) {
				const v = check(n, depth + 1);
				if (v.blocked) return v;
			}
		}
	}
	return { blocked: false };
}

export function classify(command: string): Verdict {
	return check(command, 0);
}
