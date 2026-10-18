# Changelog

## Unreleased

First version, built and tested against OpenClaw 2026.10.3.

- **Status line:** appended to each gathering result for configured agents. It counts gathering results, notices notes, reports the share of the context budget used, and nudges first to write a note, then to finish from the notes.
- **Least privilege:** reads only call metadata unless the operator grants conversation access, which adds reported token counts.
- **Tool Search:** results from `tool_call` are attributed to the tool that actually ran.
- **Note tracking (off unless `notes.pathContains` is set):** counts results since the last note and asks for one.
- **Offload (off by default):**
  - large gathering results are saved to `<workspace>/.context-pacer/<date>-<run>/` and replaced by a labelled excerpt and the file's path;
  - a truncated `web_fetch` page saved on the host is copied in, so a sandboxed agent can read it;
  - saves go through OpenClaw's root-bounded file API, which refuses symlinks and never overwrites a file;
  - for unsandboxed agents and Docker or Podman sandboxes; with `workspaceAccess` `"none"` or `"ro"`, into the sandbox workspace the agent's tools run in;
  - skipped when a run's tools start outside the folder it would save in, such as a run with its own working directory.
