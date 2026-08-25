#!/usr/bin/env node
// What a `npm publish` from this package directory would actually ship.
//
//   cd pi-incremental-py && ../shared/check-tarball.mjs
//   make pack PKG=pi-incremental-py
//
// `files` in package.json is an allowlist and there are no .npmignore backstops
// anywhere in this repo, so it is the only thing standing between the working
// tree and the registry. It is also easy to get subtly wrong: a directory entry
// matches everything under it, including whatever the tools left there.
// `files: ["py/"]` once shipped five py/__pycache__/*.pyc — bytecode for three
// CPython versions, 180 kB of a 232 kB tarball — and nothing said so, because a
// tarball that is too big is still a tarball that publishes fine.
//
// Two claims, both about the published artifact rather than the source tree:
//   1. nothing on the denylist is in it, and
//   2. every entry point `pi.extensions` names is, since a package missing its
//      own entry point installs cleanly and then fails at load time.
//
// Prints the file list either way — the point is that a human can read it
// before a release, not only that CI can gate on it. Node rather than bash
// because the input is JSON and the output is a table; shared/test/assert.sh
// covers the suites that are genuinely shell.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// The union of what the three packages' toolchains leave lying around and what
// is deliberately outside every `files` allowlist — the last of which is the
// one that would actually matter.
const DENY = [
	{ re: /(^|\/)__pycache__\//, why: "Python bytecode" },
	{ re: /(^|\/)\.venv\//, why: "virtualenv" },
	{ re: /(^|\/)\.ruff_cache\//, why: "ruff cache" },
	{ re: /(^|\/)\.hypothesis\//, why: "hypothesis database" },
	// `uv sync` writes one next to the sources it builds from, so the very
	// command the README tells a contributor to run leaves it in the tree.
	{ re: /(^|\/)[^/]*\.egg-info\//, why: "Python build metadata" },
	{ re: /(^|\/)node_modules\//, why: "dependency tree" },
	{ re: /^tsconfig\.json$/, why: "build config, not needed at runtime" },
	{ re: /^tests?\//, why: "test tier" },
	{ re: /^test-py\//, why: "test tier" },
	{ re: /(^|\/)\.env$/, why: "SECRETS" },
];

const pkgDir = process.argv[2] ?? process.cwd();
if (!existsSync(join(pkgDir, "package.json"))) {
	console.error(`check-tarball: no package.json in ${pkgDir}`);
	process.exit(1);
}

// --dry-run writes no tarball; --json puts the manifest on stdout and npm's own
// notices on stderr, which is why only stdout is captured here.
const [tarball] = JSON.parse(
	execFileSync("npm", ["pack", "--dry-run", "--json"], {
		cwd: pkgDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}),
);

const kb = (n) => `${(n / 1000).toFixed(1)} kB`;
const paths = tarball.files.map((f) => f.path);

console.log(
	`${tarball.name}@${tarball.version} — ${tarball.files.length} files, ${kb(tarball.unpackedSize)} unpacked`,
);
for (const f of tarball.files) console.log(`  ${kb(f.size).padStart(9)}  ${f.path}`);

const problems = [];

for (const path of paths) {
	const hit = DENY.find((d) => d.re.test(path));
	if (hit) problems.push(`ships ${path} (${hit.why})`);
}

// pi resolves an extension through the `pi` manifest, never through `main` or
// `exports`, so this — not the module graph — is what has to survive the
// allowlist. Directory entries are pi's convention fallback, and a directory is
// satisfied by any file beneath it.
const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).pi ?? {};
for (const key of ["extensions", "skills", "prompts", "themes"]) {
	for (const entry of manifest[key] ?? []) {
		const rel = entry.replace(/^\.\//, "").replace(/\/$/, "");
		if (!paths.some((p) => p === rel || p.startsWith(`${rel}/`))) {
			problems.push(`pi.${key} names ${entry}, which the tarball does not contain`);
		}
	}
}

if (problems.length === 0) {
	console.log("\n  ok  tarball contents");
	process.exit(0);
}

console.log("\nFAIL tarball contents");
for (const p of problems) console.log(`       ${p}`);
console.log("       `files` in package.json is an allowlist — narrow the entry that let this in.");
process.exit(1);
