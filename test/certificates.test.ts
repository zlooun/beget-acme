import { errorCode } from '../src/core/validation.js';
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPrivateKey } from 'node:crypto';
import { X509CertificateGenerator, SubjectAlternativeNameExtension } from '@peculiar/x509';
const webcrypto = globalThis.crypto;
import {
  validateCertificate,
  saveCertificate,
  certificateStatus,
  recoverCertificatePublication,
} from '../src/core/store.js';

test('cert publishing checks key match, SAN, permissions and current pointer', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beget-cert-'));

  try {
    const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const key = createPrivateKey({
      key: Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)),
      format: 'der',
      type: 'pkcs8',
    }).export({ format: 'pem', type: 'pkcs8' });
    const cert = (
      await X509CertificateGenerator.createSelfSigned(
        {
          serialNumber: '01',
          name: 'CN=example.com',
          keys,
          signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
          notBefore: new Date(Date.now() - 1000),
          notAfter: new Date(Date.now() + 30 * 86400000),
          extensions: [
            new SubjectAlternativeNameExtension([
              { type: 'dns', value: 'example.com' },
              { type: 'dns', value: '*.example.com' },
            ]),
          ],
        },
        webcrypto,
      )
    ).toString('pem');
    assert(validateCertificate(key, cert, 'example.com'));
    assert.throws(
      () => validateCertificate(key, cert, 'wrong.example.com'),
      (e) => errorCode(e) === 'CERT_SAN_MISMATCH',
    );
    assert.throws(
      () => validateCertificate('not a key', cert, 'example.com'),
      (e) => errorCode(e) === 'CERT_INVALID',
    );
    const output = path.join(dir, 'output');
    const result1 = await saveCertificate(key, cert, output, 'example.com');
    const result2 = await saveCertificate(key, cert, output, 'example.com');
    assert.notEqual(result1.path, result2.path);
    // Simulate a crash in the Windows junction replacement gap.
    await fs.writeFile(
      path.join(output, 'pending-publication.json'),
      JSON.stringify({ version: path.basename(result2.path) }),
    );
    await fs.rm(path.join(output, 'current'), { recursive: true, force: true });
    await recoverCertificatePublication(output, 'example.com');
    assert.equal(await recoverCertificatePublication(output, 'example.com'), undefined);
    assert.equal(await fs.realpath(path.join(output, 'current')), await fs.realpath(result2.path));

    // A crash after switching current must only remove the pending marker.
    await fs.writeFile(
      path.join(output, 'pending-publication.json'),
      JSON.stringify({ version: path.basename(result2.path) }),
    );
    const previousLink = await fs.readlink(path.join(output, 'current'));
    await recoverCertificatePublication(output, 'example.com');
    assert.equal(await fs.readlink(path.join(output, 'current')), previousLink);
    const status = await certificateStatus(path.join(output, 'current', 'fullchain.pem'));
    assert.equal(status.present, true);
    assert.equal(status.daysLeft > 0, true);
    const keyFile = path.join(output, 'current', 'privkey.pem');
    await fs.writeFile(keyFile, 'invalid key');
    await assert.rejects(certificateStatus(path.join(output, 'current', 'fullchain.pem')), {
      code: 'CERT_KEY_UNREADABLE',
    });
    await fs.rm(keyFile);
    await assert.rejects(certificateStatus(path.join(output, 'current', 'fullchain.pem')), {
      code: 'CERT_KEY_UNREADABLE',
    });
    const otherKeys = await webcrypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const otherKey = createPrivateKey({
      key: Buffer.from(await webcrypto.subtle.exportKey('pkcs8', otherKeys.privateKey)),
      format: 'der',
      type: 'pkcs8',
    }).export({ format: 'pem', type: 'pkcs8' });
    await fs.writeFile(keyFile, otherKey);
    await assert.rejects(certificateStatus(path.join(output, 'current', 'fullchain.pem')), {
      code: 'CERT_KEY_MISMATCH',
    });
    await fs.writeFile(keyFile, key, { mode: 0o600 });

    if (process.platform !== 'win32') {
      const stat = await fs.stat(path.join(output, 'current', 'privkey.pem'));
      assert.equal(stat.mode & 0o777, 0o600);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('publication recovery rejects a marker escaping the output directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beget-publication-'));

  try {
    const marker = path.join(dir, 'pending-publication.json');
    await fs.writeFile(marker, JSON.stringify({ version: '../outside' }));
    await assert.rejects(recoverCertificatePublication(dir, 'example.com'), {
      code: 'CERT_PUBLICATION_INVALID',
    });
    assert.equal(await fs.readFile(marker, 'utf8'), JSON.stringify({ version: '../outside' }));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
