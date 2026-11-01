import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { errorCode } from '../src/core/validation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OperationStore } from '../src/core/store.js';

async function fixture(fn: (store: OperationStore) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'beget-test-'));

  try {
    await fn(new OperationStore(dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('lock is exclusive and released after thrown exception', async () => {
  await fixture(async (store) => {
    await assert.rejects(
      store.locked(async () => {
        const owner = await store.lockInfo();
        assert(owner && typeof owner.pid === 'number' && owner.pid > 0);
        await assert.rejects(
          store.locked(async () => {}),
          (e) => errorCode(e) === 'OPERATION_LOCKED',
        );
        throw Error('simulated failure');
      }),
      /simulated failure/,
    );
    assert.equal(await store.lockInfo(), null);
  });
});

test('stale lock fails closed; only operator may remove it', async () => {
  await fixture(async (store) => {
    await fs.mkdir(store.lockDir);
    await assert.rejects(
      store.locked(async () => {}),
      (e) => errorCode(e) === 'OPERATION_LOCKED',
    );
    assert(await store.lockInfo());
  });
});

test('journal is persisted, validated and removed on explicit cleanup', async () => {
  await fixture(async (store) => {
    assert.equal(await store.journal(), null);
    await store.writeJournal({ name: '_acme-challenge.example.com', values: ['token-abc123456'] });
    assert.equal((await store.journal())?.values[0], 'token-abc123456');
    await store.clearJournal();
    assert.equal(await store.journal(), null);
  });
});

test('unknown journal versions and nested entries fail closed', async () => {
  await fixture(async (store) => {
    await store.writeJournal({
      name: '_acme-challenge.example.com',
      values: ['token-abc123456'],
      version: 99,
    });
    await assert.rejects(store.journal(), { code: 'JOURNAL_INVALID' });
    await store.writeJournal({
      name: '_acme-challenge.example.com',
      values: ['token-abc123456'],
      entries: [
        {
          name: '_acme-challenge.other.net',
          values: ['token-def123456'],
          phase: 'prepared',
          entries: [],
        },
      ],
    });
    await assert.rejects(store.journal(), { code: 'JOURNAL_INVALID' });
  });
});

for (const phase of [
  'planned',
  'prepared',
  'published',
  'verified',
  'cleanup-started',
  'cleanup-requested',
]) {
  test(
    `process death releases OS lock and preserves ${phase} journal`,
    { timeout: 15000 },
    async () => {
      await fixture(async (store) => {
        const child = fork(
          fileURLToPath(new URL('./fixtures/lock-worker.js', import.meta.url)),
          [store.dir, phase],
          { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
        );
        const exited = once(child, 'exit');
        let childErrors = '';
        child.stderr?.on('data', (chunk: Buffer) => {
          childErrors += chunk.toString();
        });

        try {
          const message = await once(child, 'message', { signal: AbortSignal.timeout(10000) });
          assert.equal(message[0], 'ready');
          await assert.rejects(
            new OperationStore(store.dir).locked(async () => {
              assert.fail(
                `Concurrent operation must never enter; child exit=${child.exitCode}; stderr=${childErrors}`,
              );
            }),
            { code: 'OPERATION_LOCKED' },
          );
          assert.equal(await store.lockIsActive(), true);
          child.kill('SIGKILL');
          await exited;
          assert.equal(await store.lockInfo(), null);
          await new OperationStore(store.dir).locked(async () => {
            assert.equal((await store.requireJournal()).phase, phase);
          });
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await exited;
          }
        }
      });
    },
  );
}

test('corrupt lock storage never permits an operation', async () => {
  await fixture(async (store) => {
    await fs.writeFile(path.join(store.dir, 'operation.sqlite'), 'not a database');
    await assert.rejects(
      store.locked(async () => {
        assert.fail('Must not run');
      }),
      { code: 'LOCK_STORAGE_INVALID' },
    );
  });
});
