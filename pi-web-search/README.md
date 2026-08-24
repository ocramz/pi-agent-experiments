# pi-web-search

Web search for the [pi coding agent](https://pi.dev): one agent tool per
search backend, each normalising into a shared result shape (title, URL,
text excerpt) sized for a model's context.

## Tools

| Tool | Backend | Key |
|---|---|---|
| `web_search_tavily` | [Tavily](https://tavily.com) | `TAVILY_API_KEY` |

`web_search_tavily` parameters: `query` (required), `max_results` (default
5), `topic` (`general`/`news`), `search_depth` (`basic`/`advanced`),
`time_range` (`day`/`week`/`month`/`year` or shorthand like `3d`),
`start_date`/`end_date` (`YYYY-MM-DD`), `include_answer`,
`include_domains`/`exclude_domains`. The rest of the Tavily request body
(images, favicons, raw content, usage accounting) is pinned to text-only
defaults — see `src/tavily.ts`, which is one curl call:

```
curl --request POST \
  --url https://api.tavily.com/search \
  --header 'Authorization: Bearer <token>' \
  --header 'Content-Type: application/json' \
  --data '{"query": "who is Leo Messi?", ...}'
```

## Setup

Export `TAVILY_API_KEY` before starting pi. A missing key is a readable
tool result telling the model (and through it, you) what to set — never a
crash.

## Adding a backend

One file in `src/` exporting a `search(apiKey, opts)` that returns the
shared `SearchOutcome` from `src/types.ts`, one `pi.registerTool` call in
`extensions/index.ts`, and (if it makes live calls) one line in
`test/tui/live.test.ts`'s required-keys list. The formatter in
`src/format.ts` takes any backend's `SearchResponse`.

## Tests

Four tiers, registered through the repo Makefile like every extension:

- `npm test` — unit: request construction, normalisation, truncation and
  error paths, against a stubbed `fetch`. No network.
- `npm run typecheck` — `tsc` against pi's real declarations.
- `npm run test:tui` — live: a real model drives `web_search_tavily`
  through pi's TUI in a pty. Needs both `OPENROUTER_API_KEY` and
  `TAVILY_API_KEY` in the repo-root `.env`; it refuses to start without
  them rather than skipping quietly.
- `npm run test:container` — the unit suite again inside the pinned
  distroless image, as the unprivileged user with no `node_modules`.
