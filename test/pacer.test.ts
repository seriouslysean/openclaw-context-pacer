import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULTS, Pacer, appendStatus, resolveConfig, statusLine } from '../src/pacer.ts';

test('only configured agents are paced', () => {
  const pacer = new Pacer(resolveConfig({ agents: ['research'] }));
  assert.equal(pacer.applies('research'), true);
  assert.equal(pacer.applies('main'), false);
  assert.equal(pacer.applies(undefined), false);
});

test('does nothing until agents are configured', () => {
  assert.equal(new Pacer(resolveConfig(undefined)).applies('research'), false);
  assert.equal(new Pacer(resolveConfig({ agents: 'research' })).applies('research'), false);
  assert.equal(new Pacer(resolveConfig({ agents: [] })).applies('research'), false);
});

test('falls back to an approximate share from request size, and prefers reported usage', () => {
  const pacer = new Pacer(DEFAULTS);
  pacer.recordUsage('r1', 100_000, 70_000, true);
  assert.match(pacer.onToolResult('r1', 'web_fetch', {})!, /about 70% of budget \(approx\)\. Context is filling up/);
  pacer.recordUsage('r1', undefined, 50_000);
  assert.match(pacer.onToolResult('r1', 'web_fetch', {})!, /about 50% of budget\./);
  pacer.recordUsage('r1', undefined, 45_000, true);
  assert.match(pacer.onToolResult('r1', 'web_fetch', {})!, /about 50% of budget\./);
  pacer.recordUsage('r1', undefined, 60_000, true);
  assert.match(pacer.onToolResult('r1', 'web_fetch', {})!, /about 60% of budget \(approx\)/);
});

test('non-gathering tools pass unchanged', () => {
  const pacer = new Pacer(DEFAULTS);
  assert.equal(pacer.onToolResult('r1', 'read', { path: 'notes/a.md' }), undefined);
  assert.equal(pacer.onToolResult('r1', 'exec', {}), undefined);
});

test('counts gathering results and asks for a note after noteEvery', () => {
  const pacer = new Pacer(resolveConfig({ noteEvery: 3 }));
  assert.match(pacer.onToolResult('r1', 'web_search', {})!, /1 gathering result so far · no notes written yet\.$/);
  pacer.onToolResult('r1', 'web_fetch', {});
  const third = pacer.onToolResult('r1', 'web_fetch', {})!;
  assert.match(third, /3 gathering results so far/);
  assert.match(third, /Add what these sources showed to your notes/);
});

test('a write under the notes path resets the count; other writes do not', () => {
  const pacer = new Pacer(resolveConfig({ noteEvery: 2 }));
  pacer.onToolResult('r1', 'web_fetch', {});
  pacer.onToolResult('r1', 'write', { path: 'drafts/x.md' });
  assert.match(pacer.onToolResult('r1', 'web_fetch', {})!, /no notes written yet\. Add/);
  pacer.onToolResult('r1', 'write', { path: 'notes/2026-10-15-topic.md' });
  const line = pacer.onToolResult('r1', 'web_search', {})!;
  assert.match(line, /last note 1 result ago\.$/);
});

test('reports context share and says to finish once past wrapUpAt', () => {
  const pacer = new Pacer(resolveConfig({ wrapUpAt: 0.6 }));
  pacer.recordUsage('r1', 100_000, 40_000);
  assert.match(pacer.onToolResult('r1', 'web_fetch', {})!, /context about 40% of budget\.$/);
  pacer.recordUsage('r1', undefined, 65_000);
  assert.match(pacer.onToolResult('r1', 'web_fetch', {})!, /about 65% of budget\. Context is filling up/);
});

test('omits the context share when OpenClaw reported no usage', () => {
  const line = statusLine({ gathers: 2, notes: 1, sinceNote: 1 }, DEFAULTS);
  assert.doesNotMatch(line, /context/);
});

test('runs are separate and bounded', () => {
  const pacer = new Pacer(resolveConfig({ maxRuns: 2 }));
  pacer.onToolResult('a', 'web_fetch', {});
  pacer.onToolResult('b', 'web_fetch', {});
  pacer.onToolResult('c', 'web_fetch', {});
  assert.equal(pacer.trackedRuns, 2);
  assert.match(pacer.onToolResult('c', 'web_fetch', {})!, /2 gathering results/);
  pacer.end('c');
  assert.equal(pacer.trackedRuns, 1);
});

test('invalid config falls back to defaults and clamps numbers', () => {
  const config = resolveConfig({ agents: [''], noteEvery: 999, wrapUpAt: 'x', notesPath: '' });
  assert.deepEqual(config.agents, []);
  assert.equal(config.noteEvery, 20);
  assert.equal(config.wrapUpAt, DEFAULTS.wrapUpAt);
  assert.equal(config.notesPath, DEFAULTS.notesPath);
});

test('appendStatus adds a text block and keeps the original content', () => {
  const result = { content: [{ type: 'text', text: 'page' }], details: { url: 'u' } };
  const out = appendStatus(result, '[pacer] x.');
  assert.deepEqual(out.content, [{ type: 'text', text: 'page' }, { type: 'text', text: '[pacer] x.' }]);
  assert.deepEqual(out.details, { url: 'u' });
  assert.deepEqual(result.content, [{ type: 'text', text: 'page' }]);
});
