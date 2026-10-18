/**
 * Offload: a large gathering result is saved in full to the agent's own workspace, where its sandbox can read it,
 * and the model sees an excerpt plus the file's path. This is the "restorable compression" pattern: nothing is
 * dropped, only moved out of context until the agent asks for it.
 *
 * The agent can write to that workspace too, so it can plant or swap in symlinks while a save runs. Every file
 * operation below it goes through OpenClaw's root-bounded file API (`root` from the plugin SDK), which refuses a
 * symlink at any point on the path, including one swapped in after a check.
 */
import { readFile, stat } from 'node:fs/promises';
import { root } from 'openclaw/plugin-sdk/security-runtime';
import type { OffloadConfig } from './pacer.ts';
import { type ToolResult, isExternal, readable, spillPath, textOf } from './tool-result.ts';

type Root = Awaited<ReturnType<typeof root>>;

/** Wraps text in OpenClaw's untrusted-content markers (`wrapExternalContent` from the plugin SDK). */
export type Wrap = (text: string, source: string) => string;

export interface OffloadRequest {
  workspaceDir: string;
  /** The run's folder name, fixed when the run first saves (see `runFolder`). */
  folder: string;
  index: number;
  name: string;
  /** The result as the model would see it. */
  original: ToolResult;
  /** The tool's own result, unwrapped from `tool_call` when Tool Search was used. */
  inner: ToolResult;
  /** Asks the pacer for room within the run's byte limit. */
  reserve: (bytes: number) => boolean;
}

export interface Offloaded {
  content: { type: 'text'; text: string }[];
  savedPath?: string;
}

/** Marks run folders this plugin created; cleanup never touches a folder without it. */
export const SENTINEL = '.context-pacer-run';
/** Keeps saved web content out of a workspace git backup, as OpenClaw does for its own staged inputs. */
export const GITIGNORE = '# Saved tool results from the context-pacer plugin; old run folders are deleted.\n*\n';
const MAX_SPILL_BYTES = 10_000_000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** `<YYYY-MM-DD>-<first 8 letters and digits of the run id>`, using the gateway's local date. */
export function runFolder(runId: string, now: Date): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${date}-${runId.replaceAll(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'run'}`;
}

/** Cuts at the last line break inside the limit when one is reasonably close, so the excerpt ends cleanly. */
export function excerpt(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const cut = text.lastIndexOf('\n', max);
  return text.slice(0, cut > max * 0.8 ? cut : max);
}

/** Keeps the newest `maxRuns` folders this plugin created in `directory`, plus the current one. */
async function prune(workspace: Root, directory: string, maxRuns: number, current: string): Promise<void> {
  const entries = await workspace.list(directory, { withFileTypes: true });
  const folders = entries.filter((entry) => entry.isDirectory && !entry.isSymbolicLink && entry.name !== current);
  const marked = await Promise.all(
    folders.map(async (entry) => ((await isMarked(workspace, `${directory}/${entry.name}`)) ? entry : undefined)),
  );
  const ours = marked.filter((entry) => entry !== undefined).toSorted((a, b) => b.mtimeMs - a.mtimeMs);
  await Promise.all(
    ours.slice(Math.max(0, maxRuns - 1)).map((old) => workspace.remove(`${directory}/${old.name}`, { recursive: true, force: true })),
  );
}

/** True when the folder carries this plugin's marker; a marker that is a symlink doesn't count. */
async function isMarked(workspace: Root, folder: string): Promise<boolean> {
  try {
    return await workspace.exists(`${folder}/${SENTINEL}`);
  } catch {
    return false;
  }
}

/** Leaves an existing file alone, including one the user wrote. */
async function createIfAbsent(workspace: Root, path: string, text: string): Promise<void> {
  try {
    await workspace.create(path, text, { private: true });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'already-exists')) {
      throw error;
    }
  }
}

async function readSpill(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size <= MAX_SPILL_BYTES ? await readFile(path, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns replacement content for a large result, or undefined to leave it as it is. A result is offloaded when the
 * text the model would see exceeds `thresholdChars`. Its readable form is saved, along with the full page when
 * `web_fetch` spilled one to a host-only file. When that readable form already fits in `excerptChars`, it is shown
 * whole and nothing is saved.
 */
export async function offload(config: OffloadConfig, wrap: Wrap, req: OffloadRequest): Promise<Offloaded | undefined> {
  const visible = textOf(req.original);
  const innerText = textOf(req.inner);
  if (visible === undefined || innerText === undefined || visible.length <= config.thresholdChars) {
    return undefined;
  }

  const external = isExternal(req.inner, innerText) || isExternal(req.original, visible);
  const label = (text: string) => (external ? wrap(text, req.name) : text);
  let body = readable(innerText, external);
  const spill = spillPath(req.inner);
  const spillText = spill ? await readSpill(spill) : undefined;
  if (spill && spillText !== undefined) {
    body = body.split(spill).join('the "Full page" section of this file');
  }

  if (body.length <= config.excerptChars && spillText === undefined) {
    return { content: [{ type: 'text', text: label(body) }] };
  }

  // The saved text keeps OpenClaw's untrusted-content warning, as web_fetch's own saved output does.
  const saved = label(body) + (spillText === undefined ? '' : `\n\n## Full page\n\n${spillText}`);
  const bytes = Buffer.byteLength(saved, 'utf8');
  if (!req.reserve(bytes)) {
    return undefined;
  }

  const workspace = await root(req.workspaceDir);
  const runDir = `${config.directory}/${req.folder}`;
  await workspace.mkdir(runDir, { private: true });
  const marker = `${runDir}/${SENTINEL}`;
  if (!(await workspace.exists(marker))) {
    await createIfAbsent(workspace, `${config.directory}/.gitignore`, GITIGNORE);
    await createIfAbsent(workspace, marker, 'Created by the context-pacer OpenClaw plugin; old run folders are deleted.\n');
    await prune(workspace, config.directory, config.maxRuns, req.folder);
  }
  const file = `${String(req.index).padStart(3, '0')}-${req.name.replaceAll(/[^A-Za-z0-9_-]/g, '')}.md`;
  // `create` fails rather than overwrite anything already at that path.
  await workspace.create(`${runDir}/${file}`, saved, { private: true });

  const savedPath = `${runDir}/${file}`;
  const shown = excerpt(body, config.excerptChars);
  const fullPage = spillText === undefined ? '' : `, plus the full page (${spillText.length.toLocaleString('en-US')} characters)`;
  const pointer = `[pacer] Showing the first ${shown.length.toLocaleString('en-US')} of ${body.length.toLocaleString('en-US')} characters${fullPage}. The full result is saved at ${savedPath}: read it with offset and limit if you need more.`;
  return { content: [{ type: 'text', text: label(shown) }, { type: 'text', text: pointer }], savedPath };
}
