// Where a trajectory goes, and getting it there without a half-written file.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConvertOutput, SessionHeader } from "./convert.ts";

/**
 * The directory trajectories are written to, or `undefined` for "off".
 *
 * Off is the default on purpose. A trajectory is a full transcript — every
 * prompt, every tool output — and a package that started writing those
 * somewhere the moment it was installed would be doing it in sessions whose
 * owner never asked. The flag beats the environment, as a command line should.
 */
export function resolveDir(flag: unknown, env: string | undefined, cwd: string): string | undefined {
	const chosen = typeof flag === "string" && flag.trim() ? flag.trim() : env?.trim() || undefined;
	return chosen === undefined ? undefined : resolve(cwd, chosen);
}

/**
 * `<start time>_<session id>.atif.json`.
 *
 * pi's own session files are named the same way, so the two sort together and
 * either one names the other. The timestamp leads so a directory shared by
 * many projects still lists in the order the sessions began.
 */
export function trajectoryFileName(header: Pick<SessionHeader, "id" | "timestamp">): string {
	return `${header.timestamp.replace(/[:.]/g, "-")}_${header.id}.atif.json`;
}

/** The image directory beside a trajectory, as the steps reference it. */
export function imageDirFor(file: string): string {
	return `${basename(file).replace(/\.json$/, "")}.images`;
}

/**
 * Write the trajectory and any images it references.
 *
 * Images first: a reader that sees the new trajectory must be able to open
 * every path it names, and Harbor's validator checks exactly that. They are
 * content-addressed, so one that already exists is already right. The
 * trajectory itself goes through a rename, so a reader — or a second write
 * racing this one — sees the old file or the new one, never a torn one.
 */
export function writeTrajectory(file: string, out: ConvertOutput): void {
	const dir = dirname(file);
	mkdirSync(dir, { recursive: true });
	for (const image of out.images) {
		const target = join(dir, image.path);
		if (existsSync(target)) continue;
		mkdirSync(dirname(target), { recursive: true });
		atomically(target, Buffer.from(image.data, "base64"));
	}
	atomically(file, `${JSON.stringify(out.trajectory, null, 2)}\n`);
}

function atomically(file: string, data: string | Buffer): void {
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, data);
	renameSync(tmp, file);
}

/** "@ocramz/pi-logging-atif@<version>", read from the package.json that shipped with this file. */
export function producer(): string {
	try {
		const pkg = JSON.parse(
			readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
		) as { name?: string; version?: string };
		return `${pkg.name ?? "pi-logging-atif"}@${pkg.version ?? "unknown"}`;
	} catch {
		return "pi-logging-atif@unknown";
	}
}
