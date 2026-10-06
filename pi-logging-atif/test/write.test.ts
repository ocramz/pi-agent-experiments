// Where a trajectory goes, and that it gets there whole.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { toTrajectory } from "../src/convert.ts";
import { imageDirFor, producer, resolveDir, trajectoryFileName, writeTrajectory } from "../src/write.ts";
import { atifErrors } from "./atif-check.ts";
import { HEADER, SCENARIOS } from "./scenarios.ts";

test("off unless a directory is configured; the flag beats the environment", () => {
	assert.equal(resolveDir(undefined, undefined, "/cwd"), undefined);
	assert.equal(resolveDir("", "", "/cwd"), undefined);
	assert.equal(resolveDir("  ", undefined, "/cwd"), undefined);
	assert.equal(resolveDir(true, undefined, "/cwd"), undefined, "a bare --atif-dir names no directory");
	assert.equal(resolveDir(undefined, "/env", "/cwd"), "/env");
	assert.equal(resolveDir("/flag", "/env", "/cwd"), "/flag");
	assert.equal(resolveDir("rel", undefined, "/cwd"), "/cwd/rel");
	assert.equal(resolveDir(undefined, "rel", "/cwd"), "/cwd/rel");
});

test("file names sort by session start and carry the session id", () => {
	assert.equal(trajectoryFileName(HEADER), `2026-10-05T12-00-00-000Z_${HEADER.id}.atif.json`);
	assert.equal(imageDirFor(`/x/${trajectoryFileName(HEADER)}`), `2026-10-05T12-00-00-000Z_${HEADER.id}.atif.images`);
});

test("writes the trajectory and its images, leaves no temp files, and rewrites in place", (t) => {
	const root = mkdtempSync(join(tmpdir(), "atif-write-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const file = join(root, "nested", "dir", "run.atif.json");

	const out = toTrajectory({ ...SCENARIOS.images(), imageDir: imageDirFor(file) });
	assert.ok(out);
	writeTrajectory(file, out);
	writeTrajectory(file, out);

	const written = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual(written, JSON.parse(JSON.stringify(out.trajectory)));
	assert.deepEqual(atifErrors(written, dirname(file)), [], "every image path resolves beside the file");

	const images = readdirSync(join(dirname(file), "run.atif.images"));
	assert.equal(images.length, 2);
	for (const name of images) {
		const bytes = readFileSync(join(dirname(file), "run.atif.images", name));
		assert.deepEqual([...bytes.subarray(1, 4)], [0x50, 0x4e, 0x47], `${name} is the decoded PNG, not base64 text`);
	}
	assert.deepEqual(readdirSync(dirname(file)).filter((f) => f.includes(".tmp-")), []);
	assert.ok(existsSync(file));
});

test("producer names this package and its version", () => {
	const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
	assert.equal(producer(), `${pkg.name}@${pkg.version}`);
});
