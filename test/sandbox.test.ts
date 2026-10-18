import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { offloadTarget } from '../src/sandbox.ts';

const WS = '/srv/agent-workspace';
const SANDBOX_WS = '/srv/sandboxes/workspace-1';
const readable = (config: unknown) => 'dir' in offloadTarget(config, 'researcher', WS);
const saveDir = (config: unknown, cwd?: string) => {
  const target = offloadTarget(config, 'researcher', WS, cwd);
  return 'dir' in target ? target.dir : undefined;
};

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

test('a sandbox with the default or read-only workspace access saves in the sandbox workspace its tools run in', () => {
  assert.equal(saveDir(config({ mode: 'all' }, undefined), SANDBOX_WS), SANDBOX_WS);
  assert.equal(saveDir(config({ mode: 'all', workspaceAccess: 'none' }, undefined), SANDBOX_WS), SANDBOX_WS);
  assert.equal(saveDir(config({ mode: 'all', workspaceAccess: 'ro' }, undefined), SANDBOX_WS), SANDBOX_WS);
  assert.equal(saveDir(config({ mode: 'non-main', backend: 'podman' }, undefined), SANDBOX_WS), SANDBOX_WS);
});

test('a none or ro sandbox gets no saved file when OpenClaw reports no absolute working directory', () => {
  assert.equal(saveDir(config({ mode: 'all' }, undefined)), undefined);
  assert.equal(saveDir(config({ mode: 'all', workspaceAccess: 'ro' }, undefined), ''), undefined);
  assert.equal(saveDir(config({ mode: 'all' }, undefined), 'workspace-1'), undefined);
});

test('a non-main session that runs unsandboxed in the agent workspace saves there', () => {
  assert.equal(saveDir(config({ mode: 'non-main' }, undefined), WS), WS);
});

test('an rw sandbox whose tools run outside the agent workspace gets no saved file', () => {
  assert.equal(saveDir(config({ mode: 'all', workspaceAccess: 'rw' }, undefined), SANDBOX_WS), undefined);
  assert.equal(saveDir(config({ mode: 'all', workspaceAccess: 'rw' }, undefined), `${WS}/`), WS);
  assert.equal(saveDir(config({ mode: 'all', workspaceAccess: 'rw' }, undefined), WS), WS);
});

test('an unsandboxed agent saves in its workspace, whatever working directory the run reports', () => {
  assert.equal(saveDir({}, SANDBOX_WS), WS);
});

test('a remote backend gets no saved file even when OpenClaw reports a local working directory', () => {
  assert.equal(saveDir(config({ mode: 'all', backend: 'ssh' }, undefined), SANDBOX_WS), undefined);
});

test('the agent entry overrides the defaults', () => {
  assert.equal(saveDir(config({ mode: 'all', workspaceAccess: 'rw' }, { workspaceAccess: 'ro' }), SANDBOX_WS), SANDBOX_WS);
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
