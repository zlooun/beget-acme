import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { SubjectAlternativeNameExtension, X509CertificateGenerator } from '@peculiar/x509';
import {
  recoverCertificateState,
  saveCertificate,
  switchCertificateLink,
} from '../src/core/store.js';

async function fixture(work: (dir: string, version: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cert-recovery-'));

  try {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const certificate = await X509CertificateGenerator.createSelfSigned({
      serialNumber: '01',
      name: 'CN=example.com',
      keys,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
      notBefore: new Date(Date.now() - 10000),
      notAfter: new Date(Date.now() + 86400000),
      extensions: [new SubjectAlternativeNameExtension([{ type: 'dns', value: 'example.com' }])],
    });
    const key = createPrivateKey({
      key: Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)),
      format: 'der',
      type: 'pkcs8',
    }).export({ format: 'pem', type: 'pkcs8' });
    const saved = await saveCertificate(key, certificate.toString('pem'), dir, ['example.com']);
    await work(dir, path.basename(saved.path));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

for (const emptyDirectory of [false, true]) {
  test(`restore missing pointer from matching local version (empty directory: ${emptyDirectory})`, async () => {
    await fixture(async (dir, version) => {
      await fs.unlink(path.join(dir, 'current'));

      if (emptyDirectory) {
        await fs.mkdir(path.join(dir, 'current'));
      }

      const restored = await recoverCertificateState(dir, ['example.com'], () => undefined);
      assert.equal(restored?.path, path.join(dir, version));
      assert.equal(
        await fs.realpath(path.join(dir, 'current')),
        await fs.realpath(path.join(dir, version)),
      );
    });
  });
}

test('invalid marker is preserved before restoring an independently validated local pair', async () => {
  await fixture(async (dir, version) => {
    await fs.writeFile(path.join(dir, 'pending-publication.json'), '{invalid');
    const restored = await recoverCertificateState(dir, ['example.com'], () => undefined);
    assert.equal(restored?.path, path.join(dir, version));
    const archive = (await fs.readdir(dir)).find((name) =>
      name.startsWith('publication-quarantine-'),
    );
    assert(archive);
    assert.equal(await fs.readFile(path.join(dir, archive), 'utf8'), '{invalid');
  });
});

test('invalid marker without a matching pair blocks issuance and is not discarded', async () => {
  await fixture(async (dir) => {
    await fs.writeFile(path.join(dir, 'pending-publication.json'), '{invalid');
    await assert.rejects(
      recoverCertificateState(dir, ['other.example.com'], () => undefined),
      { code: 'CERT_RECOVERY_REQUIRED' },
    );
    assert.equal(await fs.readFile(path.join(dir, 'pending-publication.json'), 'utf8'), '{invalid');
  });
});

test('damaged current key is preserved and does not get mistaken for a valid candidate', async () => {
  await fixture(async (dir, version) => {
    await fs.writeFile(path.join(dir, version, 'privkey.pem'), 'invalid');
    assert.equal(await recoverCertificateState(dir, ['example.com'], () => undefined), undefined);
    assert.equal(await fs.readFile(path.join(dir, version, 'privkey.pem'), 'utf8'), 'invalid');
    await assert.rejects(fs.lstat(path.join(dir, 'current')), { code: 'ENOENT' });
    assert((await fs.readdir(dir)).some((name) => name.startsWith('current-quarantine-')));
  });
});

test('unexpected nonempty current directory is never removed', async () => {
  await fixture(async (dir) => {
    await fs.unlink(path.join(dir, 'current'));
    await fs.mkdir(path.join(dir, 'current'));
    await fs.writeFile(path.join(dir, 'current', 'unrelated'), 'keep');
    await assert.rejects(
      recoverCertificateState(dir, ['example.com'], () => undefined),
      { code: 'CERT_POINTER_INVALID' },
    );
    assert.equal(await fs.readFile(path.join(dir, 'current', 'unrelated'), 'utf8'), 'keep');
  });
});

test('Windows replacement rolls back on failed new-link rename', async () => {
  await fixture(async (dir, version) => {
    const temporary = path.join(dir, '.new-link');
    const current = path.join(dir, 'current');
    await fs.symlink(
      path.join(dir, version),
      temporary,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      switchCertificateLink(temporary, current, true, async (from, to) => {
        if (from === temporary) {
          throw Object.assign(new Error('Injected rename failure'), { code: 'EIO' });
        }

        await fs.rename(from, to);
      }),
      { code: 'EIO' },
    );
    assert.equal(await fs.realpath(current), await fs.realpath(path.join(dir, version)));
    await fs.unlink(temporary);
  });
});

test('restart completes pending publication after the old pointer was backed up', async () => {
  await fixture(async (dir, version) => {
    await fs.rename(path.join(dir, 'current'), path.join(dir, 'current.previous'));
    await fs.writeFile(path.join(dir, 'pending-publication.json'), JSON.stringify({ version }));
    const restored = await recoverCertificateState(dir, ['example.com'], () => undefined);
    assert.equal(restored?.path, path.join(dir, version));
    assert.equal(
      await fs.realpath(path.join(dir, 'current')),
      await fs.realpath(path.join(dir, version)),
    );
    await assert.rejects(fs.stat(path.join(dir, 'pending-publication.json')), { code: 'ENOENT' });
  });
});

test(
  'unreadable certificate is an access error, not automatic replacement',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  async () => {
    await fixture(async (dir, version) => {
      const key = path.join(dir, version, 'privkey.pem');
      await fs.chmod(key, 0);

      try {
        await assert.rejects(
          recoverCertificateState(dir, ['example.com'], () => undefined),
          { code: 'FS_PERMISSION_DENIED' },
        );
        assert((await fs.lstat(path.join(dir, 'current'))).isSymbolicLink());
      } finally {
        await fs.chmod(key, 0o600);
      }
    });
  },
);
