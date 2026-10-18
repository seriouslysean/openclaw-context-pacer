# Configuration

Config lives at `plugins.entries.context-pacer.config`. Anything missing or invalid falls back to its default, and numbers are clamped to the ranges below.

| Key | Default | Meaning |
|---|---|---|
| `agents` | `[]` | Agent ids to pace. Empty means the plugin does nothing |
| `gatherTools` | `["web_search", "web_fetch"]` | Tools whose results count as gathering and get the status line |
| `notes.pathContains` | unset | A write counts as a note when its path contains this. Unset turns note tracking off |
| `notes.tools` | `["write", "edit"]` | Tools that can write a note |
| `notes.everyResults` | `3` | Ask for a note after this many gathering results without one (1–20) |
| `wrapUpContextFraction` | `0.6` | Share of the context budget at which the line says to stop gathering and write the answer (0.2–0.95) |
| `maxTrackedRuns` | `50` | Most runs tracked in memory at once (1–1000) |
| `offload.enabled` | `false` | Move large gathering results to files |
| `offload.thresholdChars` | `6000` | Offload once the text the model would see exceeds this many characters (1,000–100,000) |
| `offload.excerptChars` | `4000` | Characters shown in place of an offloaded result (500–20,000, and at most `thresholdChars` − 1,000) |
| `offload.directory` | `".context-pacer"` | Workspace-relative folder for saved results |
| `offload.maxRuns` | `10` | Run folders kept in the directory (1–100) |
| `offload.maxBytesPerRun` | `25000000` | Most bytes saved per run (1 MB–500 MB); past this, results stay in context |

OpenClaw has no convention for an agent's working notes; its `memory/` folder is durable memory that memory search indexes and later sessions load, so it isn't a default here.

## Examples

A web research agent that keeps working notes in `notes/`:

```json
{ "agents": ["researcher"], "notes": { "pathContains": "notes/" }, "offload": { "enabled": true } }
```

An agent that explores files, without note tracking:

```json
{ "agents": ["explorer"], "gatherTools": ["read", "exec"] }
```

Set the whole object with:

```sh
openclaw config set plugins.entries.context-pacer.config '<json>' --strict-json
```

## Reported usage

By default the pacer estimates the prompt's size from each model request (bytes / 4) and marks the share "(approx)". It overestimates, so the wrap-up nudge comes early rather than late.

For exact token counts, grant the plugin conversation access:

```sh
openclaw config set plugins.entries.context-pacer.hooks.allowConversationAccess true --strict-json
openclaw plugins reload context-pacer
```

OpenClaw gates the `llm_output` hook, which reports usage, and the `agent_end` hook behind this grant because their events also carry the prompt and the model's replies. The pacer reads only the token counts from them, and without the grant it doesn't register either hook. Without `agent_end`, finished runs aren't dropped at once; `maxRuns` still bounds how many are held.

## Where saved files go

Offloaded results are saved under `<workspace>/<offload.directory>/<YYYY-MM-DD>-<run>/<NNN>-<tool>.md`. The date is the gateway's local date when the run first saves, and `<run>` is the first eight letters and digits of OpenClaw's run id.

- **Inside the workspace.** The plugin gets the path from OpenClaw (`runtime.agent.resolveAgentWorkspaceDir`), so it follows a per-agent `workspace` setting.
- **Only where the agent can read it.** A sandboxed agent sees that workspace only with `workspaceAccess: "rw"`; with `"none"` (OpenClaw's default) or `"ro"`, its tools work in a separate sandbox workspace. So offload runs only for unsandboxed agents and `rw` sandboxes, and otherwise passes results through with a one-time warning in the gateway log. The check reads `agents.entries.<id>.sandbox`, then `agents.defaults.sandbox`. Sandboxes required by a person's role aren't visible in config and aren't detected.
- **Kept out of git backups.** OpenClaw recommends backing up the workspace with git. The plugin writes a `.gitignore` that ignores everything in the directory, as OpenClaw does for its own staged inputs. An existing `.gitignore` there is left alone.
- **Files are private:** mode 0600, in folders with mode 0700.
- **Path rules:** `offload.directory` must be a plain relative path; a leading dot is fine, `.` and `..` are not. Anything else falls back to the default.
- **No symlinks, no overwrites:** the agent can write to the same workspace, so every save goes through OpenClaw's root-bounded file API (`root` from `openclaw/plugin-sdk/security-runtime`). It refuses a symlink anywhere below the workspace, including a dangling one and one swapped in during a save, and never replaces an existing file. How strictly a swap is caught depends on the platform and fs-safe's native helper (`@openclaw/fs-safe` 0.24.2, bundled with OpenClaw 2026.10.3, `docs/security-model.md`).
- **Cleanup:** each run folder holds a `.context-pacer-run` marker. When a run saves its first file, marked folders beyond the newest `offload.maxRuns` are deleted. Folders without the marker are never touched.

## How the defaults were chosen

`offload.thresholdChars` and `offload.excerptChars` were sized on one research agent's stored results on OpenClaw 2026.10.3:
- A five-result `web_search` in readable form was 3,685 characters at the median and 4,661 at the 90th percentile, so a 4,000-character excerpt shows a typical search whole.
- A fetched page was about 6,300 characters at the median.

Agents with other tools may want different values.
