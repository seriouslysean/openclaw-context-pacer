import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { Pacer, appendStatus, resolveConfig } from './pacer.ts';

type Usage = { input?: number; cacheRead?: number; cacheWrite?: number };
type Ctx = { agentId?: string; runId?: string; contextTokenBudget?: number };

function promptTokens(usage: Usage | undefined): number | undefined {
  if (!usage) return undefined;
  const total = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return total > 0 ? total : undefined;
}

export default definePluginEntry({
  id: 'context-pacer',
  name: 'Context Pacer',
  description: 'Paces agents that gather with tools: a status line on each gathering result, with nudges to write notes and to finish from them.',
  register(api) {
    const pacer = new Pacer(resolveConfig(api.pluginConfig));
    const warn = (message: string) => api.logger?.warn?.(`[context-pacer] ${message}`);

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

    // Runs after a tool executes and before the result reaches the model. Fails open: any error leaves the result as is.
    api.registerAgentToolResultMiddleware(
      (event, ctx) => {
        try {
          if (!ctx.runId || !pacer.applies(ctx.agentId)) return undefined;
          const line = pacer.onToolResult(ctx.runId, event.toolName, event.args);
          return line ? { result: appendStatus(event.result, line) } : undefined;
        } catch (error) {
          warn(`left a ${event.toolName} result unchanged: ${String(error)}`);
          return undefined;
        }
      },
      { runtimes: ['openclaw'] },
    );
  },
});
