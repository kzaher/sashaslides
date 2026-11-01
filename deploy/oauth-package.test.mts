import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const command = (args: readonly string[]) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 20_000 });

test('the actual connector context includes every emitted OAuth file and its own pinned install', () => {
  const result = command(['node_modules/tsx/dist/cli.mjs', 'mcp/sasha-slides/deploy/context-files.ts']);
  assert.equal(result.status, 0, result.stderr);
  const files = new Set(result.stdout.trim().split('\n'));
  const oauth: unknown = JSON.parse(readFileSync(resolve(root, 'oauth/package.json'), 'utf8'));
  assert.ok(oauth !== null && typeof oauth === 'object');
  const exports: unknown = Reflect.get(oauth, 'exports');
  assert.ok(exports !== null && typeof exports === 'object');
  const main: unknown = Reflect.get(exports, '.');
  assert.ok(main !== null && typeof main === 'object');
  const emitted: unknown = Reflect.get(main, 'import');
  assert.equal(typeof emitted, 'string');
  if (typeof emitted !== 'string') throw Error('missing package export');
  const entry = emitted.replace(/^\.\//, '');
  for (const path of ['oauth/' + entry, 'oauth/dist/website.js', 'oauth/dist/auth-ui.js', 'oauth/dist/auth-ui.css', 'oauth/package.json', 'oauth/package-lock.json']) {
    assert.ok(files.has(path), 'missing runtime artifact: ' + path);
  }
  for (const file of files) {
    if (file.startsWith('oauth/')) assert.ok(/^oauth\/(dist\/|package(?:-lock)?\.json$)/.test(file), 'unnecessary OAuth source/dependency: ' + file);
  }
});

test('the Docker recipe installs and imports the emitted OAuth package separately', () => {
  const dockerfile = readFileSync(resolve(root, 'mcp/sasha-slides/deploy/Dockerfile'), 'utf8');
  assert.match(dockerfile, /COPY oauth\/package\.json oauth\/package-lock\.json oauth\//);
  assert.match(dockerfile, /npm ci[^\n]*--prefix oauth[^\n]*--omit=dev/);
  assert.match(dockerfile, /COPY oauth\/dist oauth\/dist/);
  assert.match(dockerfile, /import\(['"]\.\/oauth\/dist\/server\.js['"]\)/);
  assert.match(dockerfile, /import\(['"]\.\/oauth\/dist\/website\.js['"]\)/);
});

test('an existing-route connector rollout can skip nginx while still building shared auth', () => {
  const result = spawnSync('bash', ['deploy/publish.sh', '--dry-run', '--skip-nginx', 'connector'], { cwd: root, encoding: 'utf8', timeout: 25_000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /npm --prefix oauth ci/);
  assert.match(result.stdout, /npm --prefix oauth run build/);
  assert.ok(result.stdout.indexOf('npm --prefix oauth run build') < result.stdout.indexOf('computing build context'));
  assert.doesNotMatch(result.stdout, /systemctl reload nginx|cp \/tmp\/nginx-sashaslides/);
  assert.match(result.stdout, /check GET https:\/\/[^ ]+\/connector\/healthz/);
});
