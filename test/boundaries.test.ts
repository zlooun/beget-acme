import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { boundedResponseText } from '../src/core/response.js';
import { accountSigner, createAccountKey } from '../src/acme/crypto.js';
import { readAccountKey } from '../src/acme/account-key.js';
import { createLogger } from '../src/core/logger.js';

test('bounded response rejects oversized streams and cancels the reader', async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(boundedResponseText(response, new AbortController().signal, 15), {
    code: 'BEGET_RESPONSE_TOO_LARGE',
  });
  assert(cancelled);
});

test('bounded response handles a split UTF-8 sequence and aborts a stalled body', async () => {
  const encoded = new TextEncoder().encode('тест');
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.subarray(0, 1));
        controller.enqueue(encoded.subarray(1));
        controller.close();
      },
    }),
  );
  assert.equal(await boundedResponseText(response, new AbortController().signal), 'тест');
  const controller = new AbortController();
  const stalled = boundedResponseText(
    new Response(new ReadableStream<Uint8Array>()),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(stalled, { name: 'AbortError' });
});

test('account key reader accepts private regular keys and rejects invalid file objects', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'account-key-'));

  try {
    const file = path.join(dir, 'account.key');
    const key = createAccountKey();
    await fs.writeFile(file, key, { mode: 0o600 });
    assert.equal((await readAccountKey(file)).toString(), key);
    await assert.rejects(readAccountKey(dir), { code: 'ACME_ACCOUNT_KEY_FILE' });
    await fs.writeFile(file, Buffer.alloc(65537));
    await assert.rejects(readAccountKey(file), { code: 'ACME_ACCOUNT_KEY_FILE' });
    await fs.writeFile(file, 'bad key');
    await assert.rejects(readAccountKey(file), { code: 'ACME_ACCOUNT_KEY' });
    assert.equal(await fs.readFile(file, 'utf8'), 'bad key');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('weak RSA account keys are refused before sending any request', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  assert.throws(() => accountSigner(privateKey.export({ format: 'pem', type: 'pkcs8' })), {
    code: 'ACME_ACCOUNT_KEY',
  });
});

test(
  'POSIX account-key symlinks and shared permissions are refused',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'account-permissions-'));

    try {
      const file = path.join(dir, 'account.key');
      const link = path.join(dir, 'linked.key');
      await fs.writeFile(file, createAccountKey(), { mode: 0o600 });
      await fs.symlink(file, link);
      await assert.rejects(readAccountKey(link), { code: 'ACME_ACCOUNT_KEY_FILE' });
      await fs.chmod(file, 0o640);
      await assert.rejects(readAccountKey(file), { code: 'ACME_ACCOUNT_KEY_PERMISSIONS' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);

test('JSON errors expose stable code and hint separately from human-readable text', () => {
  const lines: string[] = [];
  const logger = createLogger({
    json: true,
    errorOutput: {
      log: (text) => {
        lines.push(text);
      },
    },
  });
  logger.error('Readable message', { code: 'DNS_MUTATION_UNCERTAIN', hint: 'Inspect DNS.' });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /"code":"DNS_MUTATION_UNCERTAIN"/);
  assert.match(lines[0]!, /"hint":"Inspect DNS\."/);
});
