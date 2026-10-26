# How it works

## Hooks

| Hook | Use |
|---|---|
| `api.registerAgentToolResultMiddleware` | Rewrites a result after the tool runs and before the model sees it. Needs the manifest contract `agentToolResultMiddleware: ["openclaw"]` and explicit enablement ([host hooks](https://docs.openclaw.ai/plugins/sdk-overview/host-hooks)) |
| `model_call_started`, `model_call_ended` | The run's `contextTokenBudget`, and a size estimate from `requestPayloadBytes` / 4, marked "(approx)". These are metadata hooks: no prompt or reply content ([hook reference](https://docs.openclaw.ai/plugins/hooks/reference)) |
| `llm_output` | Reported prompt usage, read from the transcript's last assistant message (`lastAssistant.usage`), which carries one call's usage. The event's own `usage` sums every call of the attempt, so it isn't a prompt size (OpenClaw 2026.10.7, `completeEmbeddedAttemptResult` and `captureStreamSnapshot`). If the attempt added no assistant message, that message is an earlier one and understates the prompt; the request-size estimate replaces it once larger. Registered only when the operator grants `hooks.allowConversationAccess`, because the event also carries the conversation |
| `agent_end` | Drops the run's counters, byte budget and save folder at the end of an attempt, so they restart if the run retries. Registered only with the same grant; otherwise `maxTrackedRuns` bounds them |

State is per-run counters, at most `maxTrackedRuns` runs at once. Without offload, the plugin touches no files and no network.

## Config changes

- **Plugin settings** (`plugins.entries.context-pacer`) are read when the plugin registers. With the default hybrid reload, OpenClaw replaces the plugin instance when that entry changes ([plugin runtime](https://docs.openclaw.ai/plugins/sdk-runtime), `api.config` and `api.pluginConfig`). Replacement holds new runs while runs already admitted finish with the old instance, within a 60-second budget, so a long run in progress delays the new settings ([plugin architecture](https://docs.openclaw.ai/plugins/architecture)). Both OpenClaw 2026.10.3 and 2026.10.4.
- **Sandbox and workspace settings** (`agents.*`) are read from the gateway's current config for each result (`api.runtime.config.current()`). With the default hybrid reload, OpenClaw applies changes to them without reloading plugins, so the snapshot from registration would go stale (2026.10.3 and 2026.10.4, `src/gateway/config-reload-plan.ts`).
- **A run in progress during a change.** OpenClaw resolves a run's sandbox when each attempt starts (2026.10.3 and 2026.10.4, `src/agents/workspace-sandbox.ts`), but the plugin judges each result by the settings current at that moment. So during a change, a run still in progress is judged by the new settings. Switching from a remote backend to Docker or Podman during a run can point that run at a file its tools can't see. Change backends between runs.

## Every agent's results

Registering tool-result middleware affects more than the agents in `agents`. While any middleware is registered for the `openclaw` runtime, OpenClaw checks every tool result of every agent on that runtime against its middleware limits before it calls any middleware, including results the pacer then leaves alone (OpenClaw 2026.10.3 and 2026.10.4, `src/agents/harness/tool-result-middleware.ts`). A result inside the limits passes unchanged. Past them:

| Part | Limit | Past it |
|---|---|---|
| Text block | 100,000 characters | Cut to 100,000 |
| Image block | 5,000,000 characters of data | Dropped, unless no block would be left |
| Content blocks | 200 | The rest dropped |
| Other block types | Text and image only | Dropped, unless none would be left; nested tool-result blocks are flattened |
| `details` | 100,000 bytes of UTF-8 JSON, 1,000 keys, 20 levels | Replaced by `{ "truncated": true, "originalSizeBytes": n }` |
| `details` values JSON can't hold | Functions, repeated objects such as cycles, bigints | Functions and repeats dropped, bigints turned into strings |

A test hands the pacer's middleware to OpenClaw's own middleware runner from the SDK and checks the text-block and `details` size rows, the `details` limit at its exact byte boundary.

Paced agents' results pass the same check before the pacer sees them. A `tool_call` result whose `details` pass 100,000 bytes reaches the pacer without the tool's own result, so it gets the status line but isn't offloaded. The limit is in bytes, and under `tool_call` the page text is in `details` twice. So a `web_fetch` at its default 20,000 characters can cross it when the page is in a script that takes three bytes per character in UTF-8, such as Chinese or Japanese. A page in ASCII needs about 50,000 characters to cross it, which takes raising both `maxChars` and `tools.web.fetch.maxCharsCap`, whose defaults are 20,000 ([web fetch](https://docs.openclaw.ai/tools/web-fetch)).

The pacer can't limit this in 2026.10.3 or 2026.10.4:
- Registration takes `runtimes` and a tool `matcher`, with no agent scope. The `openclaw` runtime applies the limits before it checks a handler's matcher (`src/plugins/registry-registrars-tools-hooks.ts`).
- Registering only when `agents` is set isn't clean either. The manifest declares the middleware contract, and OpenClaw treats declared middleware that wasn't registered as missing: on each run it falls back to its plugin loader to look for it (`src/plugins/agent-tool-result-middleware-loader.ts`). What that costs isn't measured.

So an enabled plugin with an empty `agents` list still applies the limits. To leave every agent's results as they are, disable the plugin.

## Failing open

When middleware throws or returns malformed output, OpenClaw replaces the result with "Tool output unavailable due to post-processing error." So the plugin catches every error and returns `undefined`, which keeps the result as OpenClaw passed it in (see [Every agent's results](#every-agents-results)), and logs a warning. A failed save keeps the full result in context.

## Tool Search

When `tools.toolSearch` is unset, OpenClaw turns Tool Search on. Deferred tools such as `web_search` and `web_fetch` then run through its `tool_call` control, and middleware sees `toolName: "tool_call"`. The plugin reads the real tool from the result's `details.tool.name`, or from the catalog id in the call's arguments when the call failed.

In 2026.10.3, the model sees the whole `tool_call` object as escaped JSON, with the tool's text in it twice: once in `content` and once in `details`. On one research agent:

| | Median the model saw | Readable text inside |
|---|---|---|
| Fetch | 13,794 characters | about 6,300 |
| Five-result search | 8,936 characters | about 3,700 |

`tool_call` also caps its text at 20,000 characters, which cut 45 of 292 results.

Upstream removed the duplication after 2026.10.3 ([#169537](https://github.com/openclaw/openclaw/pull/169537)). The 20,000-character cap stays. On 2026.10.3, setting `tools.toolSearch: false` also removes it, but that setting is global; per-agent tool config has no `toolSearch` key.

## Offload

A gathering result is offloaded when the agent can read the folder it would be saved in (see [Where saved files go](configuration.md#where-saved-files-go)) and the text the model would see exceeds `offload.thresholdChars`:

1. The tool's own result is rendered as readable text. JSON becomes `key: value` lines, and page text keeps its line breaks. For a `tool_call`, that result comes from `details`, which also recovers text the 20,000-character cap cut off.
2. If the readable text fits in `offload.excerptChars`, it is shown whole and nothing is saved.
3. Otherwise it is saved, and the model sees the first `offload.excerptChars` characters, cut at a line break when one is close, plus the saved path.

**Which workspace.** Middleware gets the run's working directory as `event.cwd`. For an unsandboxed run, it is the run's own working directory when it has one, else the agent workspace, and `read` resolves relative paths against it. For a sandboxed run, OpenClaw sets it to the workspace the tools are rooted in, as a path on the gateway: the sandbox workspace under `none` and `ro`, the agent workspace under `rw`. It refuses any other working directory for a sandboxed run. Docker and Podman mount that folder where the tools start, read-only under `ro`, so the saved file's relative path resolves for the agent's `read`. (OpenClaw 2026.10.3 and 2026.10.4: `src/agents/workspace-sandbox.ts`, `src/agents/embedded-agent-runner/extensions.ts`, `src/agents/sandbox/workspace-mounts.ts`, `src/agents/core-coding-tools.ts`.) A result is saved in the agent workspace only when `event.cwd` is that workspace, so the relative path resolves. OpenClaw's own sandbox classifier, `resolveSandboxRuntimeStatus`, is in `openclaw/plugin-sdk/sandbox`, which ships no types and is private to OpenClaw's own plugins ([SDK subpaths](https://docs.openclaw.ai/plugins/sdk-subpaths)), so the plugin reads the sandbox mode, backend and access from config.

**Truncated fetches.** When `web_fetch` truncated a page and saved the full text on the host (`details.spill.path`), that text is copied into the saved file as a "Full page" section, and the host path is removed from what the model sees. In 2026.10.3, sandboxed agents can't read that host path ([#172430](https://github.com/openclaw/openclaw/issues/172430), fixed after 2026.10.3). If the gateway can't read the file either, the copy is skipped.

**Labelling.** Excerpts and saved files of external content keep OpenClaw's untrusted-content warning and markers (`wrapExternalContent` from the plugin SDK), as `web_fetch`'s own saved output does. `web_search` wraps every title, snippet and site name separately, and wrapping text that already holds markers turns them into sanitized placeholders. So those per-field wrappers are removed first, and the whole result is labelled once. On a live 2026.10.3 gateway, placeholders were 28–30% of each saved eight-result search before this change. A `read` from the middle of a saved file returns text without the markers, the same as reading `web_fetch`'s saved output.

**Not offloaded:** errors, and any result with a non-text block.

## Loop detection

OpenClaw's loop detection records each outcome inside the tool wrapper, right after the tool runs and before middleware (2026.10.3). So a changing status line can't make repeated identical results look new.

## After upgrading OpenClaw

- With [#169537](https://github.com/openclaw/openclaw/pull/169537), each `tool_call` result shrinks to roughly its readable size plus JSON escaping. Offload then mainly moves long fetched pages out of context.
- With [#172430](https://github.com/openclaw/openclaw/issues/172430), sandboxed agents can read `web_fetch`'s own saved output. The "Full page" copy then duplicates it.

Re-measure before changing the defaults.
