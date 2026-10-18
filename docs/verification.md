# Verification

## Checked

- **Unit tests** (`npm test`) cover:
  - the status line and its escalation;
  - config fallbacks and clamping;
  - unwrapping `tool_call`;
  - offload: excerpts, saved files, the "Full page" copy, the path rules, cleanup and `.gitignore`;
  - symlinks: a symlinked save folder, a dangling symlink at the run marker, and a run folder swapped for a symlink between a path check and the write;
  - the leak scan.
- **Typecheck** against the OpenClaw 2026.10.3 plugin SDK, in CI.
- **Replay** of 247 stored `web_search` and `web_fetch` results from one research agent on 2026.10.3 through offload with the default settings: 0 errors. What the model saw fell from 2.88 million characters to 1.02 million. That's size only, not answer quality.

## Checked on a live gateway (OpenClaw 2026.10.3)

- A linked install loads, and the gateway applies it without a restart (`openclaw plugins install --link`, then `plugins enable` and `config set`). `plugins inspect --runtime` reports it as loaded, with no diagnostics.
- Without `hooks.allowConversationAccess`, OpenClaw blocks `llm_output` and `agent_end` for a non-bundled plugin and logs a warning for each. The plugin now registers them only when the grant is set.
- A research run with offload on:
  - status lines reached the model, with a context share estimated from request size;
  - large results were saved, with the `.gitignore` in place;
  - the agent opened a saved file with `read` from a Podman sandbox with `workspaceAccess: "rw"`, despite the files' 0600 mode;
  - no result was replaced by a post-processing error.
- `model_call_ended.requestPayloadBytes` is populated for embedded runs. The estimate it gives was close to the reported prompt size early in a run.

## Not yet checked on a live gateway

- Offload for unsandboxed agents. The plugin allows it there, but only an `rw` sandbox has been run live. The rule that skips offload for `none` and `ro` sandboxes is covered by unit tests only.
- Whether `llm_output` fires per model call or once per run, with the conversation-access grant. The request-size estimate covers the gap.
- Whether `model_call_started` carries `runId` and the agent id for embedded runs.
- Whether agents read the saved files when they need more, or work from the excerpt alone.

## Checking it on your gateway

1. Run `openclaw plugins inspect context-pacer --runtime --json`. The plugin should be loaded, with no diagnostics.
2. Search the gateway log for `context-pacer`. A warning there means a result was left unchanged.
3. Ask a paced agent a question that needs several searches and fetches, then read its transcript:
   - each gathering result ends with a `[pacer]` line;
   - with offload on, large results show an excerpt and a path, and a file exists at that path in the agent's workspace;
   - nothing says "Tool output unavailable due to post-processing error".
4. If the agent ran a `read` on a saved file, check that the read succeeded inside its sandbox.
