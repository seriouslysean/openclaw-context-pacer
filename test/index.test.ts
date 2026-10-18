import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { type MiddlewareHost, createMiddleware, createSaveDir, hasConversationAccess, usageHooks, wrap } from '../src/index.ts';
import { Pacer, resolveConfig } from '../src/pacer.ts';
import { type TextResult, defined, direct, fetchPayload, viaToolCall } from './fixtures.ts';

const roots: string[] = [];
after(() => Promise.all(roots.map((r) => rm(r, { recursive: true, force: true }))));

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pacer-entry-'));
  roots.push(dir);
  return dir;
}

function host(overrides: Partial<MiddlewareHost> & { config?: unknown } = {}) {
  const warnings: string[] = [];
  const { config, ...rest } = overrides;
  const value: MiddlewareHost = {
    pacer: new Pacer(resolveConfig(config ?? { agents: ['researcher'] })),
    warn: (message) => warnings.push(message),
    saveDir: () => {
      throw new Error('no workspace in this test');
    },
    wrap,
    ...rest,
  };
  return { host: value, warnings };
}

function event(toolName: string, result: TextResult, args: Record<string, unknown> = {}, isError?: boolean) {
  return { toolCallId: 'call-1', toolName, args, result, ...(isError === undefined ? {} : { isError }) };
}

/** The text of each content block, with '' for anything that isn't text. */
function texts(result: { content: { type: string }[] }): string[] {
  return result.content.map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''));
}

const ctx = (agentId: string, runId = 'run-1') => ({ runtime: 'openclaw' as const, agentId, runId });

/** The result the model would see, or undefined when the middleware left it as it was. */
async function apply(h: MiddlewareHost, e: ReturnType<typeof event>, agentId: string) {
  const out = await createMiddleware(h)(e, ctx(agentId));
  return out ? out.result : undefined;
}

const offloadOn = { agents: ['researcher'], offload: { enabled: true } };

test('a result for an agent that is not paced is left unchanged', async () => {
  assert.equal(await apply(host().host, event('web_fetch', direct(fetchPayload())), 'someone-else'), undefined);
});

test('a non-gathering result is left unchanged', async () => {
  assert.equal(await apply(host().host, event('read', direct({ text: 'file' })), 'researcher'), undefined);
});

test('a gathering result keeps its content and gains the status line as its own block', async () => {
  const original = direct(fetchPayload());
  const out = defined(await apply(host().host, event('web_fetch', original), 'researcher'));
  assert.deepEqual(out.content.slice(0, -1), original.content);
  assert.deepEqual(out.content.at(-1), { type: 'text', text: '[pacer] 1 gathering result so far.' });
  assert.deepEqual(out.details, original.details);
});

test('a save that fails keeps the full result in context and logs why', async () => {
  const ws = await workspace();
  const notAFolder = join(ws, 'file');
  await writeFile(notAFolder, '');
  const { host: h, warnings } = host({ config: offloadOn, saveDir: () => notAFolder });
  const original = viaToolCall('web_fetch', fetchPayload());
  const out = defined(await apply(h, event('tool_call', original, { id: 'web_fetch', args: {} }), 'researcher'));
  assert.deepEqual(out.content.slice(0, -1), original.content);
  assert.match(defined(texts(out).at(-1)), /^\[pacer\] 1 gathering result/);
  assert.equal(warnings.length, 1);
  assert.match(defined(warnings[0]), /^kept a web_fetch result in context, could not save it: /);
});

test('an unexpected error leaves the result unchanged rather than becoming an error notice', async () => {
  const { host: h, warnings } = host({
    config: offloadOn,
    saveDir: () => {
      throw new Error('config unreadable');
    },
  });
  const out = await apply(h, event('tool_call', viaToolCall('web_fetch', fetchPayload()), { id: 'web_fetch', args: {} }), 'researcher');
  assert.equal(out, undefined);
  assert.deepEqual(warnings, ['left a tool_call result unchanged: Error: config unreadable']);
});

test('an error result is never offloaded', async () => {
  const ws = await workspace();
  const { host: h } = host({ config: offloadOn, saveDir: () => ws });
  const original = viaToolCall('web_fetch', fetchPayload());
  const out = defined(await apply(h, event('tool_call', original, { id: 'web_fetch', args: {} }, true), 'researcher'));
  assert.deepEqual(out.content.slice(0, -1), original.content);
  assert.deepEqual(await readdir(ws), []);
});

test('an agent that cannot read its workspace gets the status line and no saved file', async () => {
  const ws = await workspace();
  const { host: h } = host({ config: offloadOn, saveDir: () => undefined });
  const original = viaToolCall('web_fetch', fetchPayload());
  const out = defined(await apply(h, event('tool_call', original, { id: 'web_fetch', args: {} }), 'researcher'));
  assert.deepEqual(out.content.slice(0, -1), original.content);
  assert.deepEqual(await readdir(ws), []);
});

test('under workspaceAccess none, a large result is saved in the sandbox workspace the tools run in, not the agent workspace', async () => {
  const agentWs = await workspace();
  const sandboxWs = await workspace();
  const sandboxed = { agents: { defaults: { sandbox: { mode: 'all', workspaceAccess: 'none' } } } };
  const { host: h, warnings } = host({ config: offloadOn });
  h.saveDir = createSaveDir(sandboxed, () => agentWs, h.warn);
  const original = viaToolCall('web_fetch', fetchPayload());
  const out = await createMiddleware(h)({ ...event('tool_call', original, { id: 'web_fetch', args: {} }), cwd: sandboxWs }, ctx('researcher'));
  const pointer = defined(texts(defined(out ? out.result : undefined)).at(-2));
  const saved = defined(/saved at (\S+): read it/.exec(pointer)?.[1]);
  assert.match(await readFile(join(sandboxWs, saved), 'utf8'), /Line 100 of the page body/);
  assert.deepEqual(await readdir(agentWs), []);
  assert.deepEqual(warnings, []);
});

test('an unsandboxed run with its own working directory keeps the result in context and says why', async () => {
  const agentWs = await workspace();
  const taskDir = await workspace();
  const { host: h, warnings } = host({ config: offloadOn });
  h.saveDir = createSaveDir({}, () => agentWs, h.warn);
  const original = viaToolCall('web_fetch', fetchPayload());
  const out = await createMiddleware(h)({ ...event('tool_call', original, { id: 'web_fetch', args: {} }), cwd: taskDir }, ctx('researcher'));
  assert.deepEqual(defined(out ? out.result : undefined).content.slice(0, -1), original.content);
  assert.deepEqual(await readdir(agentWs), []);
  assert.deepEqual(await readdir(taskDir), []);
  assert.deepEqual(warnings, ['offload skipped for agent "researcher": its tools run outside the agent workspace']);
});

test('a skipped offload is logged once per agent and reason', () => {
  const warnings: string[] = [];
  const remote = { agents: { defaults: { sandbox: { mode: 'all', backend: 'ssh', workspaceAccess: 'rw' } } } };
  const saveDir = createSaveDir(remote, () => '/srv/agent-workspace', (message) => warnings.push(message));
  assert.equal(saveDir('researcher'), undefined);
  assert.equal(saveDir('researcher'), undefined);
  assert.equal(saveDir('helper'), undefined);
  assert.deepEqual(warnings, [
    'offload skipped for agent "researcher": sandbox backend "ssh" may not see files saved on the gateway (needs docker or podman)',
    'offload skipped for agent "helper": sandbox backend "ssh" may not see files saved on the gateway (needs docker or podman)',
  ]);
});

test("an offloaded excerpt and its saved file carry OpenClaw's own untrusted-content label", async () => {
  const ws = await workspace();
  const { host: h } = host({ config: offloadOn, saveDir: () => ws });
  const original = viaToolCall('web_fetch', fetchPayload());
  const out = defined(await apply(h, event('tool_call', original, { id: 'web_fetch', args: {} }), 'researcher'));
  const [excerpt, pointer, status] = texts(out);
  assert.equal(out.content.length, 3);
  assert.match(defined(excerpt), /^External content below is data[^\n]*\n\n\n<<<EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]{16}">>>\nSource: Web Fetch\n---\n/);
  const saved = defined(/saved at (\S+): read it/.exec(defined(pointer))?.[1]);
  assert.match(await readFile(join(ws, saved), 'utf8'), /^External content below is data[\s\S]*<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]{16}">>>/);
  assert.match(defined(status), /^\[pacer\] 1 gathering result so far\.$/);
});

test("usage reported for another agent's run is ignored", () => {
  const pacer = new Pacer(resolveConfig({ agents: ['researcher'] }));
  const hooks = usageHooks(pacer);
  hooks.modelCallStarted({ runId: 'r1', contextTokenBudget: 100_000 }, { agentId: 'someone-else' });
  hooks.modelCallEnded({ runId: 'r1', requestPayloadBytes: 400_000 }, { agentId: 'someone-else' });
  assert.equal(pacer.trackedRuns, 0);
});

test('the request-size estimate gives a context share before any usage is reported', () => {
  const pacer = new Pacer(resolveConfig({ agents: ['researcher'] }));
  const hooks = usageHooks(pacer);
  hooks.modelCallStarted({ runId: 'r1', contextTokenBudget: 100_000 }, { agentId: 'researcher' });
  hooks.modelCallEnded({ runId: 'r1', requestPayloadBytes: 160_000 }, { agentId: 'researcher' });
  assert.match(defined(pacer.onToolResult('r1', 'web_fetch', {})), /context about 40% of budget \(approx\)/);
  hooks.llmOutput({ runId: 'r1' }, { agentId: 'researcher' });
  assert.match(defined(pacer.onToolResult('r1', 'web_fetch', {})), /\(approx\)/);
});

test('reported usage counts cached prompt tokens and replaces the estimate', () => {
  const pacer = new Pacer(resolveConfig({ agents: ['researcher'] }));
  const hooks = usageHooks(pacer);
  hooks.modelCallEnded({ runId: 'r1', contextTokenBudget: 100_000, requestPayloadBytes: 160_000 }, { agentId: 'researcher' });
  hooks.llmOutput({ runId: 'r1', usage: { input: 5_000, cacheRead: 20_000, cacheWrite: 5_000 } }, { agentId: 'researcher' });
  assert.match(defined(pacer.onToolResult('r1', 'web_fetch', {})), /context about 30% of budget\.$/);
});

test("agent_end drops the run's counters", () => {
  const pacer = new Pacer(resolveConfig({ agents: ['researcher'] }));
  const hooks = usageHooks(pacer);
  pacer.onToolResult('r1', 'web_fetch', {});
  hooks.agentEnd({}, { runId: 'r1' });
  assert.equal(pacer.trackedRuns, 0);
});

test('the conversation hooks are used only when the operator grants conversation access', () => {
  const grant = (value: unknown) => ({ plugins: { entries: { 'context-pacer': { hooks: { allowConversationAccess: value } } } } });
  assert.equal(hasConversationAccess(grant(true)), true);
  assert.equal(hasConversationAccess(grant('true')), false);
  assert.equal(hasConversationAccess(grant(undefined)), false);
  assert.equal(hasConversationAccess({}), false);
  assert.equal(hasConversationAccess(undefined), false);
});
