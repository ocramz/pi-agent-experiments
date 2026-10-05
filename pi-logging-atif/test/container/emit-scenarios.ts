// Write every unit scenario out as a trajectory file, for Harbor's validator.
//
//   node test/container/emit-scenarios.ts <out-dir>
//
// The unit tier checks these with a TypeScript port of Harbor's rules; this is
// how the container tier checks them with the rules themselves. Images go
// through writeTrajectory like any real write, so the validator's file-exists
// check is exercised too.

import { join } from "node:path";
import { toTrajectory } from "../../src/convert.ts";
import { imageDirFor, writeTrajectory } from "../../src/write.ts";
import { SCENARIOS } from "../scenarios.ts";

const out = process.argv[2];
if (!out) {
	console.error("usage: emit-scenarios.ts <out-dir>");
	process.exit(2);
}

for (const [name, scenario] of Object.entries(SCENARIOS)) {
	const file = join(out, `${name}.atif.json`);
	const result = toTrajectory({ ...scenario(), imageDir: imageDirFor(file) });
	if (!result) {
		console.error(`${name}: produced no trajectory`);
		process.exit(1);
	}
	writeTrajectory(file, result);
	console.log(file);
}
