// Facts about a live trajectory, as KEY=value lines for the shell suite.
//
//   node test/container/inspect-live.ts <trajectory.atif.json> <probe>
//
// Deliberately about structure, never about prose: what the model *said* varies
// run to run, but a bash call that printed the probe has to show up as a call,
// an observation pinned to it, and token counts — or the recording is wrong.

import { readFileSync } from "node:fs";
import type { Step, Trajectory } from "../../src/atif.ts";

const [file, probe] = process.argv.slice(2);
if (!file || !probe) {
	console.error("usage: inspect-live.ts <trajectory.atif.json> <probe>");
	process.exit(2);
}
const t = JSON.parse(readFileSync(file, "utf8")) as Trajectory;
const agents = t.steps.filter((s) => s.source === "agent");
const said = (s: Step) => JSON.stringify(s.observation ?? {});

const fact = (key: string, value: unknown) => console.log(`${key}=${value}`);
const yes = (b: boolean) => (b ? "yes" : "no");

fact("SOURCES", t.steps.map((s) => s.source).join(","));
// Captured at agent_start — not the export-time fallback, which says so in extra.
fact("PROMPT_CAPTURED", yes(t.steps[0]?.source === "system" && !(t.steps[0].extra?.pi as { system_prompt?: string })?.system_prompt));

const probeCalls = agents.flatMap((s) =>
	(s.tool_calls ?? [])
		.filter((c) => c.function_name === "bash" && String(c.arguments.command ?? "").includes(probe))
		.map((c) => ({ step: s, call: c })),
);
fact("PROBE_CALLED", yes(probeCalls.length > 0));
fact(
	"PROBE_OBSERVED",
	yes(probeCalls.some(({ step, call }) =>
		step.observation?.results.some((r) => r.source_call_id === call.tool_call_id && JSON.stringify(r.content).includes(probe)),
	)),
);
fact("PROBE_IN_OBSERVATION_ANYWHERE", yes(agents.some((s) => said(s).includes(probe))));

fact("TOKENS_COUNTED", yes(agents.length > 0 && agents.every((s) => (s.metrics?.prompt_tokens ?? 0) > 0)));
fact("COST_RECORDED", yes(agents.length > 0 && agents.every((s) => typeof s.metrics?.cost_usd === "number")));
fact("MODEL_NAMED", yes(agents.length > 0 && agents.every((s) => typeof s.model_name === "string" && s.model_name.length > 0)));
const sum = agents.reduce((n, s) => n + (s.metrics?.prompt_tokens ?? 0), 0);
fact("TOTALS_MATCH", yes(t.final_metrics?.total_prompt_tokens === sum));
fact("TOTAL_COST_USD", t.final_metrics?.total_cost_usd);
fact("TOOL_DEFINITIONS", (t.agent.tool_definitions ?? []).map((d) => d.function.name).join(","));
