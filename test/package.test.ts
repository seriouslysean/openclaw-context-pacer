/**
 * `openclaw.build` names the OpenClaw version this plugin was last checked against on a live gateway, which is also its
 * floor. The devDependency can move ahead (Dependabot bumps it, CI typechecks against it) without changing either.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('build metadata, compat and the peer range all name the live-checked floor', () => {
  const floor = pkg.openclaw.compat.minGatewayVersion;
  assert.equal(pkg.openclaw.build.openclawVersion, floor);
  assert.equal(pkg.openclaw.build.pluginSdkVersion, floor);
  assert.equal(pkg.openclaw.compat.pluginApi, `>=${floor}`);
  assert.equal(pkg.peerDependencies.openclaw, `>=${floor}`);
});
