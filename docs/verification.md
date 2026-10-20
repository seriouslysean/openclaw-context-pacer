# Verification

## Checked

- **Unit tests** (`npm test`) cover:
  - the status line and its escalation;
  - config fallbacks and clamping;
  - unwrapping `tool_call`;
  - offload: excerpts, saved files, the "Full page" copy, the path rules, cleanup and `.gitignore`;
  - symlinks: a symlinked save folder, a dangling symlink at the run marker, and a run folder swapped for a symlink between a path check and the write;
  - where saves go for each sandbox mode, workspace access and backend, given the working directory a run reports;
  - the leak scan;
  - OpenClaw's own middleware runner, from the SDK, cutting an unpaced agent's oversized result once it is given the pacer's middleware (the test calls the runner directly, not OpenClaw's plugin loader).
- **Typecheck** against the OpenClaw 2026.10.3 plugin SDK, in CI.
- **Replay** of 247 stored `web_search` and `web_fetch` results from one research agent on 2026.10.3 through offload with the default settings: 0 errors. What the model saw fell from 2.88 million characters to 1.02 million. That's size only, not answer quality.

## Checked on a live gateway (OpenClaw 2026.10.3)

- A linked install loads, and the gateway applies it without a restart (`openclaw plugins install --link`, then `plugins enable` and `config set`). `plugins inspect --runtime` reports it as loaded, with no diagnostics.
- Without `hooks.allowConversationAccess`, OpenClaw blocks `llm_output` and `agent_end` for a non-bundled plugin and logs a warning for each. The plugin now registers them only when the grant is set.
- A research run with offload on:
  - status lines reached the model, with a context share estimated from request size;
  - large results were saved, with the `.gitignore` in place (at the time, one for the whole save folder; now one per run folder);
  - the agent opened a saved file with `read` from a Podman sandbox with `workspaceAccess: "rw"`, despite the files' 0600 mode;
  - no result was replaced by a post-processing error.
- `model_call_ended.requestPayloadBytes` is populated for embedded runs. The estimate it gives was close to the reported prompt size early in a run.

## Not yet checked on a live gateway

- Offload for unsandboxed agents. The plugin allows it there, but only an `rw` sandbox has been run live.
- Offload under `workspaceAccess` `none` and `ro`. Read from OpenClaw's source and covered by unit tests only:
  - that `event.cwd` is the sandbox workspace on a live gateway;
  - that a file saved there shows up in the container;
  - that the agent's `read` opens it, including from a read-only `ro` mount.
- The skips for backends other than Docker and Podman, for an unsandboxed or `rw` run whose tools start outside the agent workspace, and for a sandbox a person's role requires under `mode: "off"`. Unit tests only.
- Saved files are mode 0600 and owned by the gateway's user. A sandbox whose container user is a different host user may not be able to read them. Only a Podman sandbox has been run live.
- That a change to `agents.*` sandbox or workspace settings reaches the plugin through `api.runtime.config.current()` without a restart, and that a change to the plugin's entry replaces its instance. Read from OpenClaw's docs and source (2026.10.3 and 2026.10.4, `docs/plugins/sdk-runtime.md`, `src/gateway/config-reload-plan.ts`). The unit tests cover only that the pacer reads `current()` for each result.
- That OpenClaw applies its middleware limits to every agent's results while the plugin is enabled. Read from source (2026.10.3 and 2026.10.4, `src/agents/harness/tool-result-middleware.ts`) and checked against the 2026.10.3 SDK's runner in a unit test; not seen on a live gateway. That a 20,000-character page in Chinese or Japanese crosses the `details` limit is worked out from the byte count, not seen on a live gateway.
- What OpenClaw does on each run when a plugin declares tool-result middleware but registers none. Its loader falls back to loading the plugin (2026.10.3 and 2026.10.4, `src/plugins/agent-tool-result-middleware-loader.ts`); whether that load is cached, and what it costs, isn't checked.
- Managed project worktrees. A session with one runs its tools in a private checkout, so the plugin saves there. Whether OpenClaw keeps, reconciles or publishes those files isn't checked.
- Whether `llm_output` fires per model call or once per run, with the conversation-access grant. The request-size estimate covers the gap.
- Whether `model_call_started` carries `runId` and the agent id for embedded runs.
- Whether agents read the saved files when they need more, or work from the excerpt alone.

## Checking it on your gateway

1. Run `openclaw plugins inspect context-pacer --runtime --json`. The plugin should be loaded, with no diagnostics.
2. Search the gateway log for `context-pacer`. A warning there means a result was left unchanged.
3. Ask a paced agent a question that needs several searches and fetches, then read its transcript:
   - each gathering result ends with a `[pacer]` line;
   - with offload on, large results show an excerpt and a path, and a file exists at that path in the workspace the agent's tools run in. For a `none` or `ro` sandbox, that's the folder `openclaw sandbox explain --agent <id> --json` reports as `sandbox.effectiveHostWorkspaceRoot`;
   - nothing says "Tool output unavailable due to post-processing error".
4. If the agent ran a `read` on a saved file, check that the read succeeded inside its sandbox.
