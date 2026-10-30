import { setTimeout } from 'node:timers/promises';
import { AppError } from './errors.js';
import type { HttpTransport } from './validation.js';

/** Cancellation never releases a lock: the caller must unwind and await its work. */
export function checkRunning(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError('OPERATION_ABORTED', 'Shutdown requested; recovery state was preserved.');
  }
}

export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  checkRunning(signal);

  try {
    // Node clamps larger timer values to 1ms, so split long Retry-After waits.
    let remaining = ms;

    while (remaining > 0) {
      const interval = Math.min(remaining, 2147483647);
      await setTimeout(interval, undefined, { signal });
      remaining -= interval;
    }
  } catch (error) {
    checkRunning(signal);
    throw error;
  }
}

export function cancellableTransport(
  signal?: AbortSignal,
  transport: HttpTransport = fetch,
): HttpTransport {
  return async (url, options) => {
    checkRunning(signal);
    const signals = [signal, options.signal].filter((value): value is AbortSignal => !!value);

    try {
      return await transport(url, { ...options, signal: AbortSignal.any(signals) });
    } catch (error) {
      checkRunning(signal);
      throw error;
    }
  };
}
