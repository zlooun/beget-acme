import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const nginxImage = process.env.NGINX_TEST_IMAGE || 'nginx/nginx-unprivileged:1.31.7-alpine3.24';
const fixtureImage = process.env.ACME_TEST_IMAGE || 'zloun/beget-acme:0.2.0';
const name = `beget-nginx-test-${randomUUID()}`;
const volume = `${name}-data`;

function docker(args, expected = 0) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, expected, result.stderr || result.error?.message || result.stdout);
  return result.stdout.trim();
}

async function until(check, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await delay(250);
  }
  assert.fail(`Timed out: ${description}`);
}

function logs() {
  const result = spawnSync('docker', ['logs', name], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0);
  return result.stdout + result.stderr;
}

function peerSerial() {
  return docker([
    'run',
    '--rm',
    '--network',
    `container:${name}`,
    '--entrypoint',
    'node',
    fixtureImage,
    '--input-type=module',
    '-e',
    `
      import tls from 'node:tls';
      const socket = tls.connect({host: '127.0.0.1', port: 8443, rejectUnauthorized: false}, () => {
        process.stdout.write(socket.getPeerCertificate().serialNumber);
        socket.end();
      });
      socket.setTimeout(3000, () => socket.destroy(new Error('Test TLS timeout')));
      socket.on('error', () => { process.exitCode = 1; });`,
  ]);
}

try {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nginx-compose-'));
  try {
    await fs.copyFile(path.join(root, 'examples/nginx.env.example'), path.join(configDir, '.env'));
    const merged = JSON.parse(
      docker([
        'compose',
        '--project-directory',
        configDir,
        '--env-file',
        path.join(configDir, '.env'),
        '-f',
        path.join(root, 'examples/compose.image.yml'),
        '-f',
        path.join(root, 'examples/compose.nginx.yml'),
        'config',
        '--format',
        'json',
      ]),
    );
    assert.equal(merged.services.nginx.environment.BEGET_PASSWORD, undefined);
    assert.equal(merged.services['beget-acme'].environment.ACME_PRIVATE_KEY_MODE, '0640');
    assert.equal(merged.services.nginx.depends_on['beget-acme'].condition, 'service_healthy');
  } finally {
    assert.equal(path.dirname(path.resolve(configDir)), path.resolve(os.tmpdir()));
    await fs.rm(configDir, { recursive: true, force: true });
  }
  docker(['volume', 'create', volume]);
  // Self-signed disposable fixtures only; no real accounts, DNS or host certificates.
  docker([
    'run',
    '--rm',
    '--network',
    'none',
    '--user',
    '0:0',
    '--mount',
    `type=volume,src=${volume},dst=/fixtures`,
    '--mount',
    `type=bind,src=${path.join(root, 'examples')},dst=/examples,readonly`,
    '--entrypoint',
    'node',
    fixtureImage,
    '--input-type=module',
    '-e',
    `
      import 'reflect-metadata';
      import fs from 'node:fs/promises';
      import {createPrivateKey} from 'node:crypto';
      import {X509CertificateGenerator, SubjectAlternativeNameExtension} from '@peculiar/x509';
      for (const [version, serial] of [['cert-a','01'], ['cert-b','02']]) {
        const dir = '/fixtures/production/' + version;
        await fs.mkdir(dir, {recursive: true});
        const keys = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
        const cert = await X509CertificateGenerator.createSelfSigned({
          name:'CN=example.com', serialNumber:serial, keys,
          signingAlgorithm:{name:'ECDSA',hash:'SHA-256'},
          notBefore:new Date(Date.now()-60000), notAfter:new Date(Date.now()+86400000),
          extensions:[new SubjectAlternativeNameExtension([{type:'dns',value:'example.com'}])]
        });
        const key = createPrivateKey({key:Buffer.from(await crypto.subtle.exportKey('pkcs8',keys.privateKey)),format:'der',type:'pkcs8'});
        await fs.writeFile(dir+'/privkey.pem',key.export({format:'pem',type:'pkcs8'}),{mode:0o640});
        await fs.writeFile(dir+'/fullchain.pem',cert.toString('pem'));
      }
      await fs.symlink('cert-a','/fixtures/production/current');
      await fs.copyFile('/examples/nginx-unprivileged.conf','/fixtures/default.conf');
      async function own(dir) {
        await fs.chown(dir,10003,10002);
        for (const entry of await fs.readdir(dir,{withFileTypes:true})) {
          const file=dir+'/'+entry.name;
          if (entry.isDirectory()) { await own(file); continue; }
          if (!entry.isSymbolicLink()) await fs.chown(file,10003,10002);
        }
      }
      await own('/fixtures');`,
  ]);
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--init',
    '--network',
    'none',
    '--read-only',
    '--user',
    '10003:10003',
    '--group-add',
    '10002',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=32m',
    '--mount',
    `type=volume,src=${volume},dst=/etc/nginx/certs`,
    '--mount',
    `type=volume,src=${volume},dst=/etc/nginx/conf.d`,
    '--mount',
    `type=bind,src=${path.join(root, 'examples')},dst=/examples,readonly`,
    '-e',
    'NGINX_RELOAD_INTERVAL_SECONDS=1',
    '--entrypoint',
    '/bin/sh',
    nginxImage,
    '/examples/start-with-reload.sh',
  ]);
  await until(() => logs().includes('start worker process'), 'Nginx startup');
  assert.equal(peerSerial(), '01');
  await delay(2200);
  assert(!logs().includes('Nginx reload requested'));

  docker([
    'exec',
    name,
    'sh',
    '-c',
    `
    printf 'invalid configuration;' > /etc/nginx/conf.d/default.conf
    cd /etc/nginx/certs/production
    ln -s cert-b next
    mv -Tf next current`,
  ]);
  await until(
    () => (logs().match(/configuration check failed/g) ?? []).length >= 2,
    'failed check retries',
  );
  assert.equal(peerSerial(), '01');
  docker([
    'exec',
    name,
    'cp',
    '/examples/nginx-unprivileged.conf',
    '/etc/nginx/conf.d/default.conf',
  ]);
  await until(
    () => logs().includes('Nginx reload requested for certificate version: cert-b'),
    'reload',
  );
  await until(() => peerSerial() === '02', 'served replacement certificate');
  await delay(2200);
  assert.equal((logs().match(/Nginx reload requested/g) ?? []).length, 1);

  docker([
    'exec',
    name,
    'sh',
    '-c',
    `
    mv /tmp/nginx.pid /tmp/nginx.savedpid
    cd /etc/nginx/certs/production
    ln -s cert-a next
    mv -Tf next current`,
  ]);
  await until(() => logs().includes('Nginx reload command failed'), 'failed reload command');
  assert.equal(peerSerial(), '02');
  docker(['exec', name, 'mv', '/tmp/nginx.savedpid', '/tmp/nginx.pid']);
  await until(
    () => logs().includes('Nginx reload requested for certificate version: cert-a'),
    'reload command retry',
  );
  await until(() => peerSerial() === '01', 'served certificate after retry');

  // Killing the main watcher command must terminate its container, not orphan Nginx.
  docker([
    'exec',
    name,
    'sh',
    '-c',
    `
    master=$(cat /tmp/nginx.pid)
    parent=$(awk '/^PPid:/ {print $2}' /proc/$master/status)
    kill -KILL "$parent"`,
  ]);
  await until(
    () => docker(['inspect', name, '--format', '{{.State.Running}}']) === 'false',
    'watcher supervision',
  );
  assert.notEqual(docker(['inspect', name, '--format', '{{.State.ExitCode}}']), '0');

  docker(['start', name]);
  await until(
    () => docker(['exec', name, 'sh', '-c', 'test -s /tmp/nginx.pid; echo $?']) === '0',
    'restart',
  );
  assert.equal(peerSerial(), '01');
  docker(['exec', name, 'nginx', '-s', 'quit']);
  await until(
    () => docker(['inspect', name, '--format', '{{.State.Running}}']) === 'false',
    'master exit supervision',
  );
  assert.equal(docker(['inspect', name, '--format', '{{.State.ExitCode}}']), '1');
  docker(['start', name]);
  await until(
    () => docker(['exec', name, 'sh', '-c', 'test -s /tmp/nginx.pid; echo $?']) === '0',
    'second restart',
  );
  docker(['stop', '--time', '5', name]);
  assert.equal(docker(['inspect', name, '--format', '{{.State.ExitCode}}']), '0');
  docker(
    [
      'run',
      '--rm',
      '--network',
      'none',
      '-e',
      'NGINX_RELOAD_INTERVAL_SECONDS=0',
      '--mount',
      `type=bind,src=${path.join(root, 'examples')},dst=/examples,readonly`,
      '--entrypoint',
      'sh',
      nginxImage,
      '/examples/start-with-reload.sh',
    ],
    2,
  );
  process.stdout.write(
    'Nginx example passed: quiet polling, real TLS replacement, failed-check retry, watcher supervision and graceful stop.\n',
  );
} catch (error) {
  const result = spawnSync('docker', ['logs', name], { encoding: 'utf8', timeout: 10000 });
  process.stderr.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  throw error;
} finally {
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 15000 });
  spawnSync('docker', ['volume', 'rm', volume], { stdio: 'ignore', timeout: 15000 });
}
