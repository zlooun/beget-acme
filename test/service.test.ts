import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runService } from '../src/core/service.js';
import { loadConfig } from '../src/core/config.js';
import { OperationStore } from '../src/core/store.js';
import { AppError } from '../src/core/errors.js';

const logger = { info() {}, warn() {}, error() {} };

async function fixture(
  work: (store: OperationStore, config: Awaited<ReturnType<typeof loadConfig>>) => Promise<void>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acme-service-'));

  try {
    await work(new OperationStore(dir), await loadConfig({ ACME_DOMAINS: 'example.com' }));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('14 hours offline use only hourly retries, then return to one 12-hour wait', async () => {
  await fixture(async (store, config) => {
    let clock = Date.now();
    let attempts = 0;
    let active = false;
    const waits: number[] = [];
    const controller = new AbortController();
    await assert.rejects(
      runService(config, store, {
        logger,
        signal: controller.signal,
        now: () => clock,
        work: () => {
          assert.equal(active, false);
          active = true;
          attempts++;
          active = false;

          if (attempts <= 14) {
            return Promise.reject(new AppError('BEGET_READ_RETRYABLE', 'Offline'));
          }

          return Promise.resolve();
        },
        sleep: (ms) => {
          waits.push(ms);
          clock += ms;

          if (waits.length === 15) {
            controller.abort();
          }

          return Promise.resolve();
        },
      }),
      { code: 'OPERATION_ABORTED' },
    );
    assert.equal(attempts, 15);
    assert.deepEqual(waits, [...Array<number>(14).fill(3600000), 43200000]);
    assert.equal((await store.retryState())?.code, 'OK');
  });
});

test('once preserves Retry-After across restarts without changing a deferred deadline', async () => {
  await fixture(async (store, config) => {
    let clock = Date.now();
    const error = new AppError('ACME_RATE_LIMIT', 'Wait');
    error.retryAfterMs = 7200000;
    await assert.rejects(
      runService(config, store, {
        logger,
        once: true,
        now: () => clock,
        work: () => Promise.reject(error),
      }),
      { code: 'ACME_RATE_LIMIT' },
    );
    const saved = await store.retryState();
    assert.equal(saved?.notBefore, clock + 7200000);
    await assert.rejects(
      runService(config, new OperationStore(store.dir), {
        logger,
        once: true,
        now: () => clock,
        work: () => {
          assert.fail('Must wait');
        },
      }),
      { code: 'RENEW_RETRY_DEFERRED' },
    );
    assert.deepEqual(await store.retryState(), saved);
    clock += 7200000;
    await runService(config, store, {
      logger,
      once: true,
      now: () => clock,
      work: () => Promise.resolve(),
    });
    assert.equal((await store.retryState())?.code, 'OK');
  });
});

test('permanent operational failures remain visible and retry without a maximum count', async () => {
  await fixture(async (store, config) => {
    const controller = new AbortController();
    await assert.rejects(
      runService(config, store, {
        logger,
        signal: controller.signal,
        work: () =>
          Promise.reject(new AppError('DNS_FOREIGN_TXT', 'Operator intervention required')),
        sleep: (ms) => {
          assert(ms > 3590000);
          controller.abort();

          return Promise.resolve();
        },
      }),
      { code: 'OPERATION_ABORTED' },
    );
    assert.equal((await store.retryState())?.code, 'DNS_FOREIGN_TXT');
  });
});

test('startup recovery precedes a persisted CA deadline without bypassing it', async () => {
  await fixture(async (store, config) => {
    const deadline = Date.now() + 7200000;
    await store.setRetry(deadline, 'ACME_RATE_LIMIT');
    const steps: string[] = [];
    await assert.rejects(
      runService(config, store, {
        logger,
        once: true,
        recover: async () => {
          await store.locked(async () => {
            steps.push('recovered');
          });
        },
        work: () => {
          assert.fail('Must not create an order before Retry-After');
        },
      }),
      { code: 'RENEW_RETRY_DEFERRED' },
    );
    assert.deepEqual(steps, ['recovered']);
    assert.equal((await store.retryState())?.notBefore, deadline);
  });
});

test('recovery failures retry hourly without starting issuance', async () => {
  await fixture(async (store, config) => {
    const controller = new AbortController();
    const waits: number[] = [];
    let recoveryAttempts = 0;
    await assert.rejects(
      runService(config, store, {
        logger,
        signal: controller.signal,
        recover: () => {
          recoveryAttempts++;

          return Promise.reject(new AppError('DNS_QUERY_FAILED', 'Offline'));
        },
        work: () => {
          assert.fail('Recovery must finish first');
        },
        sleep: (ms) => {
          waits.push(ms);

          if (waits.length === 3) {
            controller.abort();
          }

          return Promise.resolve();
        },
      }),
      { code: 'OPERATION_ABORTED' },
    );
    assert.equal(recoveryAttempts, 3);
    assert(waits.every((ms) => ms > 3590000 && ms <= 3600000));
  });
});

test('failed startup recovery preserves a longer CA delay while retrying recovery hourly', async () => {
  await fixture(async (store, config) => {
    const clock = Date.now();
    await store.setRetry(clock + 7200000, 'ACME_RATE_LIMIT');
    await assert.rejects(
      runService(config, store, {
        logger,
        once: true,
        now: () => clock,
        recover: () => Promise.reject(new AppError('DNS_QUERY_FAILED', 'Offline')),
        work: () => {
          assert.fail('Recovery has not finished');
        },
      }),
      { code: 'DNS_QUERY_FAILED' },
    );
    assert.equal((await store.retryState())?.notBefore, clock + 7200000);
  });
});
