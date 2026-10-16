import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { wrapExternalContent } from 'openclaw/plugin-sdk/security-runtime';
import { offload, runFolder } from './offload.ts';
import { Pacer, appendStatus, resolveConfig } from './pacer.ts';
import { offloadReadable } from './sandbox.ts';
import { isErrorResult, resolveInner } from './tool-result.ts';

type Usage = { input?: number; cacheRead?: number; cacheWrite?: number };
type Ctx = { agentId?: string; runId?: string; contextTokenBudget?: number };

const PLUGIN_ID = 'context-pacer';

function promptTokens(usage: Usage | undefined): number | undefined {
  if (!usage) return undefined;
  const total = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return total > 0 ? total : undefined;
}

function hasConversationAccess(config: unknown): boolean {
  const entry = (config as { plugins?: { entries?: Record<string, { hooks?: { allowConversationAccess?: unknown } }> } })
    ?.plugins?.entries?.[PLUGIN_ID];
  return entry?.hooks?.allowConversationAccess === true;
}

// Sources OpenClaw's wrapper names; anything else is labelled "unknown".
function wrap(text: string, toolName: string): string {
  const source = toolName === 'web_search' || toolName === 'web_fetch' ? toolName : 'unknown';
  return wrapExternalContent(text, { source });
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: 'Context Pacer',
  description: 'Paces agents that gather with tools: a status line on each gathering result, with nudges to write notes and to finish from them, and optionally large results moved to files.',
  register(api) {
    const pacer = new Pacer(resolveConfig(api.pluginConfig));
    const warn = (message: string) => api.logger?.warn?.(`[${PLUGIN_ID}] ${message}`);
    // Offload only where the agent can open what it is pointed to; otherwise results pass through with the line only.
    const unreadableWarned = new Set<string>();
    const readable = (agentId: string): boolean => {
      if (offloadReadable(api.config, agentId)) return true;
      if (!unreadableWarned.has(agentId)) {
        unreadableWarned.add(agentId);
        warn(`offload skipped for agent "${agentId}": its sandbox can't read the workspace (needs workspaceAccess "rw")`);
      }
      return false;
    };

    // Budget and usage come from OpenClaw's own resolution for the run, so no model limits are hard-coded here.
    api.on('model_call_started', (event: Ctx, ctx: Ctx) => {
      const runId = event?.runId ?? ctx?.runId;
      if (runId && pacer.applies(ctx?.agentId)) {
        pacer.recordUsage(runId, event?.contextTokenBudget ?? ctx?.contextTokenBudget);
      }
    });
    // Fallback when usage arrives late or not at all: request bytes / 4 overestimates tokens (it includes the system
    // prompt and tool schemas), so the wrap-up nudge comes early rather than late.
    api.on('model_call_ended', (event: Ctx & { requestPayloadBytes?: number }, ctx: Ctx) => {
      const runId = event?.runId ?? ctx?.runId;
      const bytes = event?.requestPayloadBytes;
      if (runId && pacer.applies(ctx?.agentId) && typeof bytes === 'number') {
        pacer.recordUsage(runId, event?.contextTokenBudget ?? ctx?.contextTokenBudget, Math.ceil(bytes / 4), true);
      }
    });
    // `llm_output` and `agent_end` also carry the conversation, so OpenClaw admits them for an installed plugin only
    // when the operator sets `hooks.allowConversationAccess`. Without that grant the pacer works from the metadata hooks
    // above, and `maxTrackedRuns` bounds the counters instead of `agent_end`.
    if (hasConversationAccess(api.config)) {
      api.on('llm_output', (event: Ctx & { usage?: Usage }, ctx: Ctx) => {
        const runId = event?.runId ?? ctx?.runId;
        if (runId && pacer.applies(ctx?.agentId)) {
          pacer.recordUsage(runId, event?.contextTokenBudget ?? ctx?.contextTokenBudget, promptTokens(event?.usage));
        }
      });
      api.on('agent_end', (event: { runId?: string }, ctx: Ctx) => {
        const runId = event?.runId ?? ctx?.runId;
        if (runId) pacer.end(runId);
      });
    }

    // Runs after a tool executes and before the result reaches the model. Every failure returns undefined, which
    // leaves the result as it was; a thrown error or malformed output would make OpenClaw replace the result with
    // an error notice instead.
    api.registerAgentToolResultMiddleware(
      async (event, ctx) => {
        try {
          const runId = ctx.runId;
          const agentId = ctx.agentId;
          if (!runId || !agentId || !pacer.applies(agentId)) return undefined;
          const inner = resolveInner(event.toolName, event.args, event.result);
          const line = pacer.onToolResult(runId, inner.name, inner.args);
          if (!line) return undefined;
          let result = event.result;
          const failed = event.isError === true || isErrorResult(event.result);
          if (pacer.config.offload.enabled && inner.result && !failed && readable(agentId)) {
            try {
              const done = await offload(pacer.config.offload, wrap, {
                workspaceDir: api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId),
                folder: pacer.folderFor(runId, () => runFolder(runId, new Date())),
                index: pacer.gatherIndex(runId),
                name: inner.name,
                original: event.result,
                inner: inner.result,
                reserve: (bytes) => pacer.reserveBytes(runId, bytes),
              });
              if (done) result = { ...event.result, content: done.content };
            } catch (error) {
              warn(`kept a ${inner.name} result in context, could not save it: ${String(error)}`);
            }
          }
          return { result: appendStatus(result, line) };
        } catch (error) {
          warn(`left a ${event.toolName} result unchanged: ${String(error)}`);
          return undefined;
        }
      },
      { runtimes: ['openclaw'] },
    );
  },
});
