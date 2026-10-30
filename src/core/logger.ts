export interface Logger {
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

/** Central logging with injectable output streams for tests. */
export function createLogger({
  json = false,
  errorOutput = {
    log: (text: string) => {
      process.stderr.write(`${text}\n`);
    },
  },
  output = {
    log: (text: string) => {
      process.stdout.write(`${text}\n`);
    },
  },
} = {}): Logger {
  function emit(level: string, message: string, extra?: unknown): void {
    const time = new Date().toISOString();
    const destination = level === 'error' ? errorOutput : output;

    if (json) {
      destination.log(
        JSON.stringify({ timestamp: time, level, message, ...(extra ? { details: extra } : {}) }),
      );

      return;
    }

    destination.log(`${time} ${level.toUpperCase()} ${message}`);
  }

  return {
    info: (msg, extra) => emit('info', msg, extra),
    warn: (msg, extra) => emit('warn', msg, extra),
    error: (msg, extra) => emit('error', msg, extra),
  };
}
