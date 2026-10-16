/**
 * Whether an agent can read the files offload saves in its workspace.
 *
 * A sandboxed agent sees the workspace OpenClaw resolves only with `workspaceAccess: "rw"`. With `"none"` (the
 * default) or `"ro"` its tools run in a separate sandbox workspace, so a saved file's path would point at nothing it
 * can open (OpenClaw 2026.10.3, docs/gateway/sandboxing/workspace-access.md). `non-main` sandboxes every session but
 * the agent's main one, so it is treated as sandboxed. Sandboxes required by a person's role are not visible in
 * config and are not detected here.
 */
import { isRecord } from './tool-result.ts';

function sandboxSetting(config: unknown, agentId: string, key: string): unknown {
  const agents = isRecord(config) && isRecord(config.agents) ? config.agents : {};
  const entries = isRecord(agents.entries) ? agents.entries : {};
  const entry = isRecord(entries[agentId]) ? entries[agentId] : {};
  const own = isRecord(entry.sandbox) ? entry.sandbox[key] : undefined;
  if (own !== undefined) {
    return own;
  }
  const defaults = isRecord(agents.defaults) && isRecord(agents.defaults.sandbox) ? agents.defaults.sandbox : {};
  return defaults[key];
}

export function offloadReadable(config: unknown, agentId: string): boolean {
  const mode = sandboxSetting(config, agentId, 'mode') ?? 'off';
  if (mode === 'off') {
    return true;
  }
  return (sandboxSetting(config, agentId, 'workspaceAccess') ?? 'none') === 'rw';
}
