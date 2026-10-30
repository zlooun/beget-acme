import type { Config } from './config.js';
import { fail, messageFor } from './errors.js';
import type { Logger } from './logger.js';
import type { OperationStore } from './store.js';
import { checkRunning, pause } from './shutdown.js';

/** One sequential loop owns every delay, including startup and recovery failures. */
export async function runService(
  config: Config,
  store: OperationStore,
  {
    work,
    recover,
    logger,
    once = false,
    signal,
    now = Date.now,
    sleep = (ms: number) => pause(ms, signal),
  }: {
    work: () => Promise<void>;
    recover?: () => Promise<void>;
    logger: Logger;
    once?: boolean;
    signal?: AbortSignal;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<void> {
  let restoreDeadline = true;

  for (;;) {
    checkRunning(signal);
    let next = now();

    try {
      // Recovery is local/DNS repair, not a new CA order; do it before persisted delays.
      await recover?.();
      const saved = restoreDeadline ? await store.retryState() : null;
      restoreDeadline = false;

      if (saved && saved.notBefore > now()) {
        if (once && saved.code !== 'OK') {
          fail(
            'RENEW_RETRY_DEFERRED',
            `Next attempt is scheduled for ${new Date(saved.notBefore).toISOString()}.`,
          );
        }

        if (!once) {
          await sleep(saved.notBefore - now());
          continue;
        }
      }

      await work();
      next = now() + config.schedulerIntervalMs;
      await store.locked(() => store.setRetry(next, 'OK'));
      logger.info(`Certificate check succeeded; next check at ${new Date(next).toISOString()}.`);
    } catch (error) {
      checkRunning(signal);
      const known = messageFor(error);

      if (known.code === 'RENEW_RETRY_DEFERRED') {
        throw error;
      }

      next = now() + Math.max(config.retryIntervalMs, known.retryAfterMs ?? 0);
      logger.error(`Certificate check failed [${known.code}]: ${known.message}`);

      if (known.hint) {
        logger.error(`Next step: ${known.hint}`);
      }

      try {
        await store.locked(async () => {
          const previous = await store.retryState();
          // Recovery failures must not shorten a previously persisted CA backoff.
          const persisted =
            previous && previous.code !== 'OK' ? Math.max(next, previous.notBefore) : next;
          await store.setRetry(persisted, known.code);
        });
      } catch {
        // Keep retrying in memory when the filesystem or another process blocks persistence.
        logger.warn('Could not persist retry time; retaining the retry delay in this process.');
      }

      if (once) {
        throw error;
      }

      logger.warn(`Service remains running; next attempt at ${new Date(next).toISOString()}.`);
    }

    if (once) {
      return;
    }

    await sleep(Math.max(0, next - now()));
  }
}
