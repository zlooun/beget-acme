import { fail } from './errors.js';

/** Bound decoded response bytes even when Content-Length is missing or dishonest. */
export async function boundedResponseText(
  response: Response,
  signal: AbortSignal,
  maxBytes = 1048576,
) {
  const reader = response.body?.getReader();

  if (!reader) {
    signal.throwIfAborted();

    return '';
  }

  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };

  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();

      if (done) {
        return Buffer.concat(chunks).toString('utf8');
      }

      size += value.byteLength;

      if (size > maxBytes) {
        fail('BEGET_RESPONSE_TOO_LARGE', `Beget response exceeds ${maxBytes} bytes.`);
      }

      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
