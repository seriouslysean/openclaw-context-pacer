/**
 * Pacing state for agents that gather with tools, kept separate from the OpenClaw wiring so it can be tested on its own.
 *
 * The pacer never blocks anything. For each run of a configured agent it counts gathering tool results (search,
 * fetch), notices when a note is written, and returns one status line to append to the next gathering result. The
 * context share comes from the budget and usage OpenClaw reports for the run, so nothing about the model is
 * hard-coded.
 */

export type PacerConfig = {
  /** Agent ids the pacer applies to. Empty (the default) means it does nothing until configured. */
  agents: string[];
  /** Tools whose results count as gathering and receive the status line. */
  gatherTools: string[];
  /** Tools that can write a note. */
  noteTools: string[];
  /** A write counts as a note when its path contains this segment. */
  notesPath: string;
  /** Ask for a note once this many gathering results pass without one. */
  noteEvery: number;
  /** Share of the context budget at which the line says to finish from the notes. */
  wrapUpAt: number;
  /** Most runs tracked at once; the oldest is dropped beyond this, so memory stays bounded. */
  maxRuns: number;
};

export const DEFAULTS: PacerConfig = {
  agents: [],
  gatherTools: ['web_search', 'web_fetch'],
  noteTools: ['write', 'edit'],
  notesPath: 'notes/',
  noteEvery: 3,
  wrapUpAt: 0.6,
  maxRuns: 50,
};

type RunState = {
  gathers: number;
  notes: number;
  sinceNote: number;
  promptTokens?: number;
  /** True when promptTokens is estimated from request size rather than reported usage. */
  approx?: boolean;
  budget?: number;
};

function stringList(value: unknown, fallback: string[], allowEmpty = false): string[] {
  const valid = Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);
  return valid && (allowEmpty || value.length > 0) ? [...value] : [...fallback];
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** Reads `plugins.entries.context-pacer.config`; anything missing or invalid falls back to the default. */
export function resolveConfig(raw: unknown): PacerConfig {
  const c = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    agents: stringList(c.agents, DEFAULTS.agents, true),
    gatherTools: stringList(c.gatherTools, DEFAULTS.gatherTools),
    noteTools: stringList(c.noteTools, DEFAULTS.noteTools),
    notesPath: typeof c.notesPath === 'string' && c.notesPath.length > 0 ? c.notesPath : DEFAULTS.notesPath,
    noteEvery: Math.round(clamp(c.noteEvery, 1, 20, DEFAULTS.noteEvery)),
    wrapUpAt: clamp(c.wrapUpAt, 0.2, 0.95, DEFAULTS.wrapUpAt),
    maxRuns: Math.round(clamp(c.maxRuns, 1, 1000, DEFAULTS.maxRuns)),
  };
}

function writePath(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  for (const key of ['path', 'file_path', 'filePath', 'file']) {
    if (typeof a[key] === 'string') return a[key] as string;
  }
  return undefined;
}

export class Pacer {
  readonly config: PacerConfig;
  private readonly runs = new Map<string, RunState>();

  constructor(config: PacerConfig) {
    this.config = config;
  }

  applies(agentId: string | undefined): boolean {
    return typeof agentId === 'string' && this.config.agents.includes(agentId);
  }

  private state(runId: string): RunState {
    let s = this.runs.get(runId);
    if (!s) {
      s = { gathers: 0, notes: 0, sinceNote: 0 };
      this.runs.set(runId, s);
      while (this.runs.size > this.config.maxRuns) {
        this.runs.delete(this.runs.keys().next().value as string);
      }
    }
    return s;
  }

  /**
   * Records the run's resolved context budget and the prompt size of its latest model call. `approx` marks a size
   * estimated from request bytes; it never replaces a reported size from the same or a later call.
   */
  recordUsage(runId: string, budget?: number, promptTokens?: number, approx = false): void {
    const s = this.state(runId);
    if (typeof budget === 'number' && budget > 0) s.budget = budget;
    if (typeof promptTokens !== 'number' || promptTokens <= 0) return;
    if (approx && s.promptTokens !== undefined && !s.approx && promptTokens <= s.promptTokens) return;
    s.promptTokens = promptTokens;
    s.approx = approx;
  }

  /** Returns the status line for a gathering result, or undefined when the result should pass unchanged. */
  onToolResult(runId: string, toolName: string, args: unknown): string | undefined {
    const { gatherTools, noteTools, notesPath } = this.config;
    if (noteTools.includes(toolName)) {
      const path = writePath(args);
      if (path && path.includes(notesPath)) {
        const s = this.state(runId);
        s.notes += 1;
        s.sinceNote = 0;
      }
      return undefined;
    }
    if (!gatherTools.includes(toolName)) return undefined;
    const s = this.state(runId);
    s.gathers += 1;
    s.sinceNote += 1;
    return statusLine(s, this.config);
  }

  end(runId: string): void {
    this.runs.delete(runId);
  }

  get trackedRuns(): number {
    return this.runs.size;
  }
}

export function contextShare(s: Pick<RunState, 'promptTokens' | 'budget'>): number | undefined {
  return s.promptTokens && s.budget ? s.promptTokens / s.budget : undefined;
}

export function statusLine(s: RunState, config: PacerConfig): string {
  const share = contextShare(s);
  const parts = [
    `${s.gathers} gathering result${s.gathers === 1 ? '' : 's'} so far`,
    s.notes === 0 ? 'no notes written yet' : `last note ${s.sinceNote} result${s.sinceNote === 1 ? '' : 's'} ago`,
  ];
  if (share !== undefined) parts.push(`context about ${Math.round(share * 100)}% of budget${s.approx ? ' (approx)' : ''}`);
  let advice = '';
  if (share !== undefined && share >= config.wrapUpAt) {
    advice = ' Context is filling up: stop gathering and write the answer from your notes.';
  } else if (s.sinceNote >= config.noteEvery) {
    advice = ' Add what these sources showed to your notes before gathering more.';
  }
  return `[pacer] ${parts.join(' · ')}.${advice}`;
}

/** Appends the status line as a separate text block, leaving the tool's own content untouched. */
export function appendStatus<T extends { content?: unknown }>(result: T, line: string): T {
  const content = Array.isArray(result.content) ? result.content : [];
  return { ...result, content: [...content, { type: 'text', text: line }] };
}
