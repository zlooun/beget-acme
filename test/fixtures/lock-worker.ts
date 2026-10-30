import { OperationStore } from '../../src/core/store.js';
import { errorCode } from '../../src/core/validation.js';

const directory = process.argv[2];
const phase = process.argv[3];

if (!directory) {
  throw new Error('Missing temporary state directory');
}

const store = new OperationStore(directory);

try {
  await store.locked(async () => {
    if (phase) {
      await store.writeJournal({
        name: '_acme-challenge.example.com',
        values: ['token-abc123456'],
        phase,
      });
    }

    process.send?.('ready');
    await new Promise<void>(() => {
      // Keep the fixture alive until the parent forcibly terminates it.
      setInterval(() => undefined, 1000);
    });
  });
} catch (error) {
  process.send?.(errorCode(error) ?? 'UNEXPECTED_ERROR');
  process.disconnect();
}
