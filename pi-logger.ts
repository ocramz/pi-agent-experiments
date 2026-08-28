import { appendFileSync } from "node:fs";
const log = (tag: string, data: unknown) =>
  appendFileSync("/tmp/pi-debug.log",
    `\n=== ${tag} ===\n${JSON.stringify(data, null, 2)}\n`);

export default function (pi) {
  pi.on("before_provider_request", (e) => log("payload", e.payload));
  pi.on("tool_call", (e) => log("call", { name: e.toolName, input: e.input }));
  pi.on("tool_result", (e) => log("result", { name: e.toolName, content: e.content }));
}

/**
 * A few narrower views when the full payload is too much:

ctx.getSystemPrompt() — Pi's system prompt string. Note it doesn't reflect before_provider_request payload rewrites or later context message mutations.
ctx.getSystemPromptOptions() (command context only) — the structured inputs Pi used to build the prompt: custom prompt, active tools, tool snippets, guidelines, cwd, context files, skills. Good for checking whether your promptSnippet and promptGuidelines actually landed.
pi.getAllTools() — returns name, description, parameters, promptGuidelines, and sourceInfo for every tool, so you can diff your registration against what's active.
context event — fires before each LLM call with a mutable deep copy of the messages.

One gotcha worth knowing early: custom tools only get a line in the system prompt's Available tools section if you set promptSnippet — otherwise they're omitted, even though the schema is still sent. If the model is ignoring your tool, check that first.
 * 
 */