import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite } from '../core/store.js';
import https from 'node:https';
import { TLSSocket } from 'node:tls';
import { errorCode } from '../core/validation.js';
import type { HttpTransport } from '../core/validation.js';

/** Only failures before secureConnect can be retried without replaying an HTTP write. */
export class AcmeConnectionError extends Error {
  constructor(
    readonly code: string,
    options: ErrorOptions,
  ) {
    super('ACME connection failed before sending the request.', options);
  }
}

type Attempt = (
  url: string,
  options: RequestInit,
  maxVersion: 'TLSv1.3' | 'TLSv1.2',
) => Promise<Response>;
const fallbackCodes = new Set([
  'ACME_CONNECT_TIMEOUT',
  'ECONNRESET',
  'ETIMEDOUT',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
  'ERR_SSL_UNSUPPORTED_PROTOCOL',
  'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

/** Use a fresh connection and send HTTP only after certificate verification succeeds. */
const request: Attempt = (url, options, maxVersion) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);

    if (target.protocol !== 'https:' || target.username || target.password) {
      reject(new Error('ACME transport requires HTTPS without URL credentials.'));

      return;
    }

    if (options.body !== undefined && options.body !== null && typeof options.body !== 'string') {
      reject(new Error('ACME transport accepts only string request bodies.'));

      return;
    }

    let connected = false;
    const req = https.request(target, {
      method: options.method ?? 'GET',
      headers: Object.fromEntries(new Headers(options.headers)),
      agent: false,
      minVersion: 'TLSv1.2',
      maxVersion,
      rejectUnauthorized: true,
      signal: options.signal ?? undefined,
    });
    const timer = setTimeout(() => {
      req.destroy(
        Object.assign(new Error('ACME connection timeout.'), { code: 'ACME_CONNECT_TIMEOUT' }),
      );
    }, 10000);
    req.once('socket', (socket) => {
      if (!(socket instanceof TLSSocket)) {
        req.destroy(new Error('Expected a TLS socket.'));

        return;
      }

      socket.once('secureConnect', () => {
        connected = true;
        clearTimeout(timer);
        req.end(options.body ?? undefined);
      });
    });
    req.once('error', (cause: Error) => {
      clearTimeout(timer);
      const code = errorCode(cause) ?? 'UNKNOWN';
      reject(!connected ? new AcmeConnectionError(code, { cause }) : cause);
    });
    req.once('response', (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;

        if (size > 1024 * 1024) {
          response.destroy(new Error('ACME response exceeds 1 MiB.'));

          return;
        }

        chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => {
        const status = response.statusCode ?? 500;
        const headers = new Headers();

        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
        }

        const body =
          options.method === 'HEAD' || [204, 205, 304].includes(status)
            ? null
            : Buffer.concat(chunks).toString('utf8');
        resolve(new Response(body, { status, headers }));
      });
    });
  });

/** One bounded compatibility retry, sharing the caller's overall deadline and cancellation. */
export function createAcmeTransport(
  warn: (message: string) => void = () => undefined,
  attempt: Attempt = request,
  stateDir?: string,
): HttpTransport {
  const pinned = new Set<string>();
  const checked = new Set<string>();

  return async (url, options) => {
    const host = new URL(url).host;
    const file = stateDir
      ? path.join(stateDir, 'tls', createHash('sha256').update(host).digest('hex') + '.json')
      : undefined;

    if (!checked.has(host)) {
      if (file) {
        try {
          const saved: unknown = JSON.parse(await fs.readFile(file, 'utf8'));

          if (
            typeof saved === 'object' &&
            saved !== null &&
            'host' in saved &&
            saved.host === host &&
            'maxVersion' in saved &&
            saved.maxVersion === 'TLSv1.2'
          ) {
            pinned.add(host);
            warn('ACME ' + host + ': using saved TLS 1.2 preference.');
          }
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') {
            warn('ACME TLS preference could not be read; using normal TLS negotiation.');
          }
        }
      }

      checked.add(host);
    }

    if (pinned.has(host)) {
      return attempt(url, options, 'TLSv1.2');
    }

    try {
      return await attempt(url, options, 'TLSv1.3');
    } catch (error) {
      if (
        options.signal?.aborted ||
        !(error instanceof AcmeConnectionError) ||
        !fallbackCodes.has(error.code)
      ) {
        throw error;
      }

      warn(
        `ACME connection failed before HTTP (${error.code}); retrying once with TLS 1.2. Server certificate verification remains enabled.`,
      );

      const response = await attempt(url, options, 'TLSv1.2');
      pinned.add(host);

      if (file) {
        try {
          await atomicWrite(file, JSON.stringify({ host, maxVersion: 'TLSv1.2' }) + '\n');
        } catch {
          // Never replay a successful HTTP write because preference persistence failed.
          warn('ACME TLS 1.2 preference could not be saved; it remains active for this process.');
        }
      }

      warn('ACME ' + host + ': TLS 1.2 succeeded; subsequent requests will use TLS 1.2.');

      return response;
    }
  };
}
