# pi-logging-atif

Records [pi](https://pi.dev) sessions as **ATIF** trajectories. ATIF (Agent Trajectory Interchange Format) is
[Harbor's format for agent runs](https://docs.harborframework.com/agents/atif): one JSON
document with every step. A step records who spoke, what the agent called and what came back,
and the tokens and cost each model call took. Harbor's tooling, trainers and viewers read it as is.

```bash
pi install npm:@ocramz/pi-logging-atif
PI_ATIF_DIR=~/atif pi                  # or: pi --atif-dir ~/atif
```

**It is off until you choose a directory.** A trajectory is a full transcript: every prompt
and every tool output. Nothing is recorded, and nothing is added to the session, until
`PI_ATIF_DIR` or `--atif-dir` names somewhere to put it. The flag wins over the variable.

Once a directory is set, each session is kept as one file:

```
<dir>/<session start>_<session id>.atif.json
<dir>/<session start>_<session id>.atif.images/   # only if the session had images
```

The file is rewritten after every prompt, after a compaction, and when the session ends
(quit, `/new`, `/resume`, `/fork`). Each rewrite goes through a rename, so a reader sees the
previous version or the new one and never a partial file. It works with `--no-session` as
well. If a write fails, pi says so once and the session carries on.

Without a directory, `/atif-export <path>` writes the current session on demand. With one,
`/atif-export` alone writes the session's usual file immediately.

Check a trajectory with Harbor's own validator:

```bash
uvx --from harbor python -m harbor.utils.trajectory_validator ~/atif/*.atif.json
```

## What gets recorded

The trajectory is built from the session **branch**: the root-to-leaf path pi has persisted,
which is the same path pi's own `/export` walks. Resuming, reloading, forking and moving
around with `/tree` therefore need no special handling. The file always shows the branch
you are currently on. Branches you left behind remain in pi's session file.

| pi | ATIF (`ATIF-v1.7`) |
|---|---|
| System prompt | A `system` step, emitted again only when the prompt changes |
| Your message | A `user` step. Images become files in the `.images/` directory, named by content hash |
| A model reply | An `agent` step. Details are below this table |
| Tool results | `observation.results` on the agent step that made the calls, each pinned to its call by `source_call_id` |
| `!command` | A `user` step `!command`, with the output as its observation. `!!command` never reached the model, so it is not recorded |
| Extension-injected messages, branch summaries | `system` steps marked `extra.context_management: {type: "injection", boundary: "append"}` |
| Compaction | A `system` step `{type: "compaction", boundary: "replace"}` whose observation is the summary. It is followed by **copies** of the turns pi kept, marked `is_copied_context`, because pi keeps a recent tail as well as the summary |
| Thinking level, model changes | `reasoning_effort` and `model_name` on the agent steps |

Each agent step records:
- `message`: the reply text.
- `reasoning_content`: the model's visible thinking. Redacted thinking is noted in `extra`.
- `tool_calls`.
- `model_name`.
- `llm_call_count: 1`.
- `metrics`:
  - `prompt_tokens` counts **all** input tokens, cached ones included, as ATIF defines it.
    pi itself reports uncached input separately.
  - `cached_tokens`
  - `completion_tokens`
  - `cost_usd`
  - cache writes and reasoning tokens, under `extra`.

Aborted and failed calls are kept as steps, with their stop reason.

The root records:
- `session_id`: pi's session id.
- `agent`: `pi`, the pi version, the current model, and the active tools in OpenAI
  function-calling shape.
- `final_metrics`: totals over the agent steps, with copies excluded. Spend that belongs to
  no step, such as a compaction's summary call, is reported separately under
  `final_metrics.extra.auxiliary`.

Everything pi-specific lives under `extra.pi`, including the session entry id each step came
from.

### The system prompt

pi 0.84 does not store the system prompt in the session. While recording is on, the
extension stores it at the start of each prompt as a custom session entry
(`atif-system-prompt`), and only when it has changed. pi keeps that entry with the session
and never sends it to the model. It is captured at `agent_start`, after every extension has
modified the prompt, so it matches what the provider receives regardless of extension load
order. The interactive tier checks this against the provider's own record of the call.

If you `/atif-export` a session that was recorded without the extension, the prompt in
effect at export time is used instead. That step is marked `extra.pi.system_prompt:
"current"`.

## Limits

- **This is the transcript, not the payload.** An extension's `context` handler can change
  what the model is shown on each call (pi-incremental-py does this), and those changes are
  not persisted anywhere this extension can read.
- **One file per session, for the current branch.** Abandoned branches are not exported.
- **Tool definitions are the active set at write time.** If tools are turned on or off
  mid-session, only the final set is recorded.

## Layout

```
extensions/index.ts   wiring: the flag, prompt capture, when to write, /atif-export
src/convert.ts        the conversion — pure, a session branch in, a trajectory out
src/atif.ts           the ATIF types, transcribed from Harbor's pydantic models
src/write.ts          where files go, and writing them atomically
```

`src/` does not import pi. `extensions/index.ts` passes pi's real `getBranch()` into
`toTrajectory`, so `npm run typecheck` is what fails if pi's session types drift away from
the ones `src/convert.ts` expects.

## Tests

| Tier | Command | What it covers |
|---|---|---|
| unit | `npm test` | Every branch shape the converter handles (`test/scenarios.ts`), each checked against a port of Harbor's rules (`test/atif-check.ts`), plus writes and paths |
| types | `npm run typecheck` | That pi 0.84.2's `SessionEntry` still fits the converter's input types |
| interactive | `npm run test:tui` | The extension inside a real pi, driven by a scripted faux model. The system step must equal the prompt the provider was handed, the file is written at `agent_end`, and "off" means off. Free, with no key needed |
| container | `npm run test:container` | The unit suite in the image. Harbor's **own** validator (pinned in `shared/versions.env`) over every unit scenario. Then a live model run under `--no-session`, whose output Harbor must accept. The live run costs one cheap call |

The scenarios are shared deliberately. The unit tier checks them with the port, and the
container tier checks the same scenarios with Harbor. So if the port and Harbor ever
disagree, a test fails instead of the unit tier passing files Harbor would reject.
