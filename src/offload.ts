/**
 * Offload: a large gathering result is saved in full to the agent's own workspace, where its sandbox can read it,
 * and the model sees an excerpt plus the file's path. This is the "restorable compression" pattern: nothing is
 * dropped, only moved out of context until the agent asks for it.
 */
import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OffloadConfig } from './pacer.ts';
import { type ToolResult, isExternal, readable, spillPath, textOf } from './tool-result.ts';

/** Wraps text in OpenClaw's untrusted-content markers (`wrapExternalContent` from the plugin SDK). */
export type Wrap = (text: string, source: string) => string;

export type OffloadRequest = {
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
};

export type Offloaded = { content: { type: 'text'; text: string }[]; savedPath?: string };

/** Marks run folders this plugin created; cleanup never touches a folder without it. */
export const SENTINEL = '.context-pacer-run';
/** Keeps saved web content out of a workspace git backup, as OpenClaw does for its own staged inputs. */
export const GITIGNORE = '# Saved tool results from the context-pacer plugin; old run folders are deleted.\n*\n';
const MAX_SPILL_BYTES = 10_000_000;

/** `<YYYY-MM-DD>-<first 8 letters and digits of the run id>`, using the gateway's local date. */
export function runFolder(runId: string, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `${date}-${runId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'run'}`;
}

/** Cuts at the last line break inside the limit when one is reasonably close, so the excerpt ends cleanly. */
export function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  return text.slice(0, cut > max * 0.8 ? cut : max);
}

/** Creates the folder if needed and refuses a symlink anywhere on the path below the workspace. */
async function ensureRealDir(workspaceDir: string, relative: string): Promise<string> {
  let current = workspaceDir;
  for (const segment of relative.split('/')) {
    current = join(current, segment);
    await mkdir(current, { recursive: true, mode: 0o700 });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${current} is not a plain folder`);
  }
  return current;
}

/** Keeps the newest `maxRuns` folders this plugin created, plus the current one. */
export async function prune(root: string, maxRuns: number, current: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  const ours: { path: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (path === current) continue;
    try {
      await stat(join(path, SENTINEL));
      ours.push({ path, mtime: (await stat(path)).mtimeMs });
    } catch {
      // Not created by this plugin.
    }
  }
  ours.sort((a, b) => b.mtime - a.mtime);
  for (const old of ours.slice(Math.max(0, maxRuns - 1))) {
    await rm(old.path, { recursive: true, force: true });
  }
}

/** Leaves an existing file alone, including one the user wrote. */
async function writeIfAbsent(path: string, text: string): Promise<void> {
  try {
    await writeFile(path, text, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
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
  if (visible === undefined || innerText === undefined || visible.length <= config.thresholdChars) return undefined;

  const external = isExternal(req.inner, innerText) || isExternal(req.original, visible);
  const label = (text: string) => (external ? wrap(text, req.name) : text);
  let body = readable(innerText, external);
  const spill = spillPath(req.inner);
  const spillText = spill ? await readSpill(spill) : undefined;
  if (spill && spillText !== undefined) body = body.split(spill).join('the "Full page" section of this file');

  if (body.length <= config.excerptChars && spillText === undefined) {
    return { content: [{ type: 'text', text: label(body) }] };
  }

  // The saved text keeps OpenClaw's untrusted-content warning, as web_fetch's own saved output does.
  const saved = label(body) + (spillText === undefined ? '' : `\n\n## Full page\n\n${spillText}`);
  const bytes = Buffer.byteLength(saved, 'utf8');
  if (!req.reserve(bytes)) return undefined;

  const runDir = await ensureRealDir(req.workspaceDir, `${config.directory}/${req.folder}`);
  const fresh = await stat(join(runDir, SENTINEL)).then(
    () => false,
    () => true,
  );
  if (fresh) {
    const root = join(req.workspaceDir, config.directory);
    await writeIfAbsent(join(root, '.gitignore'), GITIGNORE);
    await writeFile(join(runDir, SENTINEL), 'Created by the context-pacer OpenClaw plugin; old run folders are deleted.\n', { mode: 0o600 });
    await prune(root, config.maxRuns, runDir);
  }
  const file = `${String(req.index).padStart(3, '0')}-${req.name.replace(/[^A-Za-z0-9_-]/g, '')}.md`;
  // `wx` fails rather than overwrite anything already at that path.
  await writeFile(join(runDir, file), saved, { mode: 0o600, flag: 'wx' });

  const savedPath = `${config.directory}/${req.folder}/${file}`;
  const shown = excerpt(body, config.excerptChars);
  const fullPage = spillText === undefined ? '' : `, plus the full page (${spillText.length.toLocaleString('en-US')} characters)`;
  const pointer = `[pacer] Showing the first ${shown.length.toLocaleString('en-US')} of ${body.length.toLocaleString('en-US')} characters${fullPage}. The full result is saved at ${savedPath}: read it with offset and limit if you need more.`;
  return { content: [{ type: 'text', text: label(shown) }, { type: 'text', text: pointer }], savedPath };
}
