/**
 * Where offload may save an agent's results so the agent can read them, or why it can't.
 *
 * A sandboxed agent sees the workspace OpenClaw resolves only with `workspaceAccess: "rw"`. With `"none"` (the
 * default) or `"ro"` its tools run in a separate sandbox workspace, so a saved file's path would point at nothing it
 * can open (OpenClaw 2026.10.3, docs/gateway/sandboxing/workspace-access.md). `non-main` sandboxes every session but
 * the agent's main one, so it is treated as sandboxed. Sandboxes required by a person's role are not visible in
 * config and are not detected here.
 *
 * Only Docker and Podman mount a folder on the gateway into the sandbox. SSH and Crabbox seed a remote workspace once,
 * and OpenShell runs remotely or syncs around `exec`, so a file saved on the gateway can be missing from what the
 * agent's tools see (OpenClaw 2026.10.3, docs/gateway/sandboxing/ssh-backend.md, openshell-backend.md,
 * crabbox-backend.md). Backends added by plugins are unknown, so they are treated the same way.
 */
import { isRecord } from './tool-result.ts';

/** The folder to save in, or why results stay in context. */
export type Target = { dir: string } | { skip: string };

/** Backends whose sandbox mounts the folder OpenClaw resolved on the gateway (docs/gateway/sandboxing/docker-backend.md). */
const LOCAL_BACKENDS = new Set(['docker', 'podman']);

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

export function offloadTarget(config: unknown, agentId: string, workspace: string): Target {
  const mode = sandboxSetting(config, agentId, 'mode') ?? 'off';
  if (mode === 'off') {
    return { dir: workspace };
  }
  // OpenClaw's own default when no backend is set (docs/gateway/sandboxing/modes-scope-and-backend.md).
  const setting = sandboxSetting(config, agentId, 'backend');
  const backend = typeof setting === 'string' && setting.trim() ? setting.trim().toLowerCase() : 'docker';
  if (!LOCAL_BACKENDS.has(backend)) {
    return { skip: `sandbox backend "${backend}" may not see files saved on the gateway (needs docker or podman)` };
  }
  if ((sandboxSetting(config, agentId, 'workspaceAccess') ?? 'none') !== 'rw') {
    return { skip: `its sandbox can't read the workspace (needs workspaceAccess "rw")` };
  }
  return { dir: workspace };
}
