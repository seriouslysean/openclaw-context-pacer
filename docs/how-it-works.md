# How it works

## Hooks

| Hook | Use |
|---|---|
| `api.registerAgentToolResultMiddleware` | Rewrites a result after the tool runs and before the model sees it. Needs the manifest contract `agentToolResultMiddleware: ["openclaw"]` and explicit enablement ([host hooks](https://docs.openclaw.ai/plugins/sdk-overview/host-hooks)) |
| `model_call_started`, `model_call_ended` | The run's `contextTokenBudget`, and a size estimate from `requestPayloadBytes` / 4, marked "(approx)". These are metadata hooks: no prompt or reply content ([hook reference](https://docs.openclaw.ai/plugins/hooks/reference)) |
| `llm_output` | Reported prompt usage. Registered only when the operator grants `hooks.allowConversationAccess`, because the event also carries the conversation |
| `agent_end` | Drops the run's counters. Registered only with the same grant; otherwise `maxTrackedRuns` bounds them |

State is per-run counters, at most `maxTrackedRuns` runs at once. Without offload, the plugin touches no files and no network.

## Failing open

When middleware throws or returns malformed output, OpenClaw replaces the result with "Tool output unavailable due to post-processing error." So the plugin catches every error and returns `undefined`, which keeps the original result, and logs a warning. A failed save keeps the full result in context.

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
