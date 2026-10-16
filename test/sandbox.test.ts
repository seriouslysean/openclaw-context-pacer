import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { offloadReadable } from '../src/sandbox.ts';

const config = (defaults: object | undefined, entry: object | undefined) => ({
  agents: { defaults: defaults && { sandbox: defaults }, entries: { researcher: entry && { sandbox: entry } } },
});

test('an unsandboxed agent can read saved files', () => {
  assert.equal(offloadReadable({}, 'researcher'), true);
  assert.equal(offloadReadable(config({ mode: 'off' }, undefined), 'researcher'), true);
});

test('a sandbox with read-write workspace access can read saved files', () => {
  assert.equal(offloadReadable(config({ mode: 'all', workspaceAccess: 'rw' }, undefined), 'researcher'), true);
  assert.equal(offloadReadable(config({ mode: 'all' }, { workspaceAccess: 'rw' }), 'researcher'), true);
});

test('a sandbox with the default or read-only workspace access cannot, so nothing is offloaded', () => {
  assert.equal(offloadReadable(config({ mode: 'all' }, undefined), 'researcher'), false);
  assert.equal(offloadReadable(config({ mode: 'all', workspaceAccess: 'none' }, undefined), 'researcher'), false);
  assert.equal(offloadReadable(config({ mode: 'all', workspaceAccess: 'ro' }, undefined), 'researcher'), false);
  assert.equal(offloadReadable(config({ mode: 'non-main' }, undefined), 'researcher'), false);
});

test('the agent entry overrides the defaults', () => {
  assert.equal(offloadReadable(config({ mode: 'all', workspaceAccess: 'rw' }, { workspaceAccess: 'ro' }), 'researcher'), false);
  assert.equal(offloadReadable(config({ mode: 'all' }, { mode: 'off' }), 'researcher'), true);
});
