import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const npm = process.env.npm_execpath;
assert(npm, 'Run this check through npm run package:check.');
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, [npm, ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
const [manifest] = JSON.parse(run(['pack', '--dry-run', '--json', '--ignore-scripts']));
assert(
  manifest.files.some(({ path: name }) => name === 'dist/cli.js'),
  'Build before checking the package.',
);
for (const { path: name } of manifest.files) {
  assert(
    /^(dist\/|docs\/|examples\/|package\.json$|\.env\.example$|README\.md$|SECURITY\.md$|CHANGELOG\.md$|LICENSE$)/.test(
      name,
    ),
    `Unexpected package file: ${name}`,
  );
  assert(
    !/(^|\/)(state|output|secrets|node_modules|\.git)(\/|$)|\.(key|pem|p12|pfx)$/.test(name),
    `Private runtime file: ${name}`,
  );
}
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beget-package-'));
try {
  const [archive] = JSON.parse(
    run(['pack', '--json', '--ignore-scripts', '--pack-destination', dir]),
  );
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'package-smoke', private: true }),
  );
  run(
    [
      'install',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      path.join(dir, archive.filename),
    ],
    dir,
  );
  const cli = path.join(dir, 'node_modules', 'beget-acme', 'dist', 'cli.js');
  for (const args of [['--version'], ['help'], ['init']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  assert((await fs.readFile(path.join(dir, '.env'), 'utf8')).includes('ACME_DOMAINS='));
  process.stdout.write(
    `Package verified: ${manifest.files.length} allowed files; installed CLI and init work.\n`,
  );
} finally {
  // Verify the resolved target before recursive removal.
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  await fs.rm(dir, { recursive: true, force: true });
}
