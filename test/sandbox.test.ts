import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { offloadTarget } from '../src/sandbox.ts';

const WS = '/srv/agent-workspace';
const readable = (config: unknown) => 'dir' in offloadTarget(config, 'researcher', WS);

const config = (defaults: object | undefined, entry: object | undefined) => ({
  agents: { defaults: defaults && { sandbox: defaults }, entries: { researcher: entry && { sandbox: entry } } },
});

test('an unsandboxed agent can read saved files', () => {
  assert.equal(readable({}), true);
  assert.equal(readable(config({ mode: 'off' }, undefined)), true);
});

test('a sandbox with read-write workspace access can read saved files', () => {
  assert.equal(readable(config({ mode: 'all', workspaceAccess: 'rw' }, undefined)), true);
  assert.equal(readable(config({ mode: 'all' }, { workspaceAccess: 'rw' })), true);
});

test('a sandbox with the default or read-only workspace access cannot, so nothing is offloaded', () => {
  assert.equal(readable(config({ mode: 'all' }, undefined)), false);
  assert.equal(readable(config({ mode: 'all', workspaceAccess: 'none' }, undefined)), false);
  assert.equal(readable(config({ mode: 'all', workspaceAccess: 'ro' }, undefined)), false);
  assert.equal(readable(config({ mode: 'non-main' }, undefined)), false);
});

test('the agent entry overrides the defaults', () => {
  assert.equal(readable(config({ mode: 'all', workspaceAccess: 'rw' }, { workspaceAccess: 'ro' })), false);
  assert.equal(readable(config({ mode: 'all' }, { mode: 'off' })), true);
});

test('a sandbox on a backend other than docker or podman gets no saved file, since its tools may not see the gateway disk', () => {
  for (const backend of ['ssh', 'openshell', 'crabbox', 'some-plugin-backend']) {
    assert.equal(readable(config({ mode: 'all', workspaceAccess: 'rw', backend }, undefined)), false, backend);
  }
  assert.equal(readable(config({ mode: 'all', workspaceAccess: 'rw' }, { backend: 'ssh' })), false);
  for (const backend of ['docker', 'podman']) {
    assert.equal(readable(config({ mode: 'all', workspaceAccess: 'rw', backend }, undefined)), true, backend);
  }
  assert.equal(readable(config({ mode: 'all', workspaceAccess: 'rw' }, undefined)), true);
  assert.equal(readable(config({ mode: 'off', backend: 'ssh' }, undefined)), true);
});
