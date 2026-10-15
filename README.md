# openclaw-context-pacer

An [OpenClaw](https://docs.openclaw.ai) plugin (id `context-pacer`) that paces agents that gather with tools, such as research, browsing or file exploration. They keep notes and finish from them instead of gathering until their context overflows.

After each gathering result (by default `web_search` and `web_fetch`), the pacer appends one status line before the result reaches the model:

```text
[pacer] 7 gathering results so far · last note 3 results ago · context about 48% of budget. Add what these sources showed to your notes before gathering more.
```

It escalates in two steps:
- once `noteEvery` gathering results pass without a note, it asks for one;
- once the run's prompt reaches `wrapUpAt` of the context budget, it says to stop gathering and write the answer from the notes.

## Bounds

- **Scoped:** only agents listed in `agents` are paced. The default is none, so the plugin does nothing until configured. Results for every other agent pass through untouched, and only results from `gatherTools` get a line.
- **Never blocks:** it doesn't veto, cap or rewrite tool calls. It only appends a text block; the tool's own content is unchanged.
- **Fails open:** any error leaves the result as it was, with a warning in the gateway log.
- **Agnostic:** it uses the context budget and usage OpenClaw reports for the run (`contextTokenBudget`, `llm_output` usage), so no model name or window size is hard-coded. When usage hasn't been reported, it estimates from the per-call request size (`model_call_ended.requestPayloadBytes` / 4) and marks the share "(approx)". That overestimates, so the wrap-up nudge comes early rather than late. With neither, the line leaves out the context share.
- **Small:** per-run counters only, at most `maxRuns` runs held at once and dropped at `agent_end`. No network, no files, no stored state.

## Config (`plugins.entries.context-pacer.config`)

| Key | Default | Meaning |
|---|---|---|
| `agents` | `[]` | Agent ids to pace; empty means off |
| `gatherTools` | `["web_search", "web_fetch"]` | Tools whose results count as gathering and get the line |
| `noteTools` | `["write", "edit"]` | Tools that can write a note |
| `notesPath` | `"notes/"` | A write counts as a note when its path contains this |
| `noteEvery` | `3` | Ask for a note after this many gathering results without one (1–20) |
| `wrapUpAt` | `0.6` | Share of the context budget at which to say "finish from your notes" (0.2–0.95) |
| `maxRuns` | `50` | Most runs tracked at once (1–1000) |

## How it hooks in

- `api.registerAgentToolResultMiddleware` (manifest contract `agentToolResultMiddleware: ["openclaw"]`) rewrites a result after the tool runs and before the model sees it ([host hooks](https://docs.openclaw.ai/plugins/sdk-overview/host-hooks)). Installed plugins need the contract plus explicit enablement.
- `model_call_started` and `llm_output` supply the run's `contextTokenBudget` and prompt usage ([prompt and session hooks](https://docs.openclaw.ai/plugins/hooks/prompt-and-session)).
- `agent_end` drops the run's counters.

## Not yet verified

- Whether `llm_output` fires per model call or once per run; the request-size fallback covers the second case.
- Whether `model_call_ended.requestPayloadBytes` is populated for embedded runs.
- The plugin has not been loaded by an OpenClaw gateway yet.
- Whether `model_call_started` carries `runId` and the agent id for embedded runs.
- Whether the hooks above need a manifest declaration beyond the middleware contract.

## Develop

```sh
npm test    # node --test, Node 24.16+ (built-in TypeScript type stripping)
```

Install from a checkout with `openclaw plugins install --link <path to this folder>`. Then enable it, set `agents`, and restart the gateway:

```json5
{ plugins: { entries: { "context-pacer": { enabled: true, config: { agents: ["<agent id>"] } } } } }
```

To pace something other than web research, set `gatherTools` (for example `["read", "exec"]` for a file-exploring agent) and `notesPath` to wherever that agent keeps notes.
