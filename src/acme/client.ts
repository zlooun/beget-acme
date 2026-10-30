import { createAcmeTransport } from './transport.js';
import { errorCode } from '../core/validation.js';
import { parseDocument } from './types.js';
import type { AcmeDocument } from './types.js';
import type { HttpTransport } from '../core/validation.js';
import { AppError, fail } from '../core/errors.js';
import { accountSigner, base64url } from './crypto.js';

export const DIRECTORIES = Object.freeze({
  staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
  production: 'https://acme-v02.api.letsencrypt.org/directory',
});

export function retryDelay(value: string | null | undefined, now = Date.now()) {
  if (!value) {
    return 2000;
  }

  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;

  return Number.isFinite(delay) ? Math.max(100, delay) : 2000;
}

export interface ClientOptions {
  accountKey: string | Buffer;
  directoryUrl: string;
  fetchImpl?: HttpTransport;
  requestTimeoutMs?: number;
  pollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}
type AcmeOperation =
  | 'directory'
  | 'newNonce'
  | 'newAccount'
  | 'newOrder'
  | 'authorization'
  | 'challenge'
  | 'finalize'
  | 'certificate'
  | 'resource';

export interface AcmeResult {
  operation?: AcmeOperation;
  response: Response;
  data: AcmeDocument;
  text: string;
}
export class AcmeClient {
  readonly signer: ReturnType<typeof accountSigner>;
  readonly directoryUrl: string;
  readonly fetch: HttpTransport;
  readonly requestTimeoutMs: number;
  readonly pollTimeoutMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  nonce: string | undefined;
  kid: string | undefined;
  directory: AcmeDocument = {};

  constructor({
    accountKey,
    directoryUrl,
    fetchImpl = createAcmeTransport(),
    requestTimeoutMs = 30000,
    pollTimeoutMs = 300000,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  }: ClientOptions) {
    this.signer = accountSigner(accountKey);
    this.directoryUrl = directoryUrl;
    this.fetch = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.pollTimeoutMs = pollTimeoutMs;
    this.sleep = sleep;
    this.now = now;
  }

  url(value: unknown): string {
    if (typeof value !== 'string') {
      fail('ACME_RESPONSE_INVALID', 'Missing CA URL.');
    }

    let parsed;

    try {
      parsed = new URL(value);
    } catch {
      fail('ACME_RESPONSE_INVALID', 'CA returned an invalid URL.');
    }

    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
      fail('ACME_RESPONSE_INVALID', 'ACME requires an HTTPS URL without credentials or fragments.');
    }

    return value;
  }

  private operationFor(url: string): AcmeOperation {
    if (url === this.directoryUrl) {
      return 'directory';
    }

    for (const operation of ['newNonce', 'newAccount', 'newOrder'] as const) {
      if (url === this.directory[operation]) {
        return operation;
      }
    }

    return 'resource';
  }

  async request(
    url: string,
    options: RequestInit = {},
    timeoutMs = this.requestTimeoutMs,
    operation = this.operationFor(url),
  ): Promise<AcmeResult> {
    this.url(url);

    try {
      const response = await this.fetch(url, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))),
      });
      this.nonce = response.headers.get('replay-nonce') || undefined;
      const text = await response.text();
      let data: AcmeDocument = {};

      if (text && !text.startsWith('-----BEGIN CERTIFICATE-----')) {
        let parsed: unknown;

        try {
          parsed = JSON.parse(text);
        } catch {
          if (response.ok) {
            fail('ACME_RESPONSE_INVALID', 'CA returned invalid JSON.');
          }

          // A proxy HTML body must not hide the original HTTP error status.
          parsed = {};
        }

        try {
          data = parseDocument(parsed);
        } catch (cause) {
          if (cause instanceof AppError && cause.code === 'ACME_RESPONSE_INVALID') {
            throw new AppError(cause.code, `${operation}: ${cause.message}`, { cause });
          }

          throw cause;
        }
      }

      return { response, data, text, operation };
    } catch (cause) {
      if (cause instanceof AppError) {
        throw cause;
      }

      throw new AppError(
        'ACME_TRANSPORT',
        `ACME ${operation} failed (${/^[A-Z0-9_]{1,80}$/.test(errorCode(cause) ?? '') ? errorCode(cause) : 'TRANSPORT_ERROR'}); its outcome may be unknown.`,
        { cause },
      );
    }
  }

  check(result: AcmeResult): AcmeResult {
    if (result.response.ok) {
      return result;
    }

    const type = result.data?.type;
    const accountDenied =
      result.operation === 'newAccount' && type === 'urn:ietf:params:acme:error:unauthorized';
    const accountProblem = accountDenied ? result.data.accountProblem : undefined;
    const code =
      result.response.status === 429 || type === 'urn:ietf:params:acme:error:rateLimited'
        ? 'ACME_RATE_LIMIT'
        : accountDenied
          ? accountProblem === 'deactivated'
            ? 'ACME_ACCOUNT_DEACTIVATED'
            : accountProblem === 'revoked'
              ? 'ACME_ACCOUNT_REVOKED'
              : 'ACME_ACCOUNT_UNAUTHORIZED'
          : type === 'urn:ietf:params:acme:error:unauthorized'
            ? 'ACME_VALIDATION_FAILED'
            : 'ACME_HTTP_ERROR';
    // Expose only a bounded protocol error name, never arbitrary detail or response content.
    const problem =
      /^urn:ietf:params:acme:error:([A-Za-z][A-Za-z0-9]{0,63})$/.exec(type ?? '')?.[1] ?? 'unknown';
    const error = new AppError(
      code,
      `CA rejected ${result.operation ?? 'resource'} (HTTP ${result.response.status}; ${problem}${accountProblem ? `; account ${accountProblem}` : ''}).`,
      {
        hint: accountDenied
          ? 'The CA rejected the ACME account key. Preserve existing state and diagnose the account before issuing again.'
          : 'Inspect DNS and recovery state before retrying; use staging for diagnostics.',
      },
    );
    // Do not echo CA detail fields, which may contain tokens or other inputs.
    error.retryAfterMs = retryDelay(result.response.headers.get('retry-after'), this.now());
    throw error;
  }

  async initialize() {
    const { data } = this.check(await this.request(this.directoryUrl));

    for (const name of ['newNonce', 'newAccount', 'newOrder'] as const) {
      this.url(data?.[name]);
    }

    this.directory = data;
  }

  async post(
    url: string,
    payload?: unknown,
    {
      useJwk = false,
      deadline,
      operation,
    }: { useJwk?: boolean; deadline?: number; operation?: AcmeOperation } = {},
  ): Promise<AcmeResult> {
    const timeout = () => {
      const remaining =
        deadline === undefined
          ? this.requestTimeoutMs
          : Math.min(this.requestTimeoutMs, deadline - this.now());

      if (remaining <= 0) {
        fail('ACME_POLL_TIMEOUT', 'Timed out waiting for the CA.');
      }

      return remaining;
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.nonce) {
        this.check(
          await this.request(this.url(this.directory.newNonce), { method: 'HEAD' }, timeout()),
        );
      }

      if (!this.nonce || !/^[A-Za-z0-9_-]+$/.test(this.nonce)) {
        fail('ACME_NONCE_MISSING', 'CA did not provide a valid replay nonce.');
      }

      const protectedHeader = base64url(
        JSON.stringify({
          alg: this.signer.alg,
          nonce: this.nonce,
          url: this.url(url),
          ...(useJwk ? { jwk: this.signer.jwk } : { kid: this.url(this.kid) }),
        }),
      );
      this.nonce = undefined;
      const encoded = payload === undefined ? '' : base64url(JSON.stringify(payload));
      const result = await this.request(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/jose+json',
            accept: 'application/json, application/pem-certificate-chain',
          },
          body: JSON.stringify({
            protected: protectedHeader,
            payload: encoded,
            signature: this.signer.sign(`${protectedHeader}.${encoded}`),
          }),
        },
        timeout(),
        operation,
      );

      if (
        result.response.status === 400 &&
        result.data?.type === 'urn:ietf:params:acme:error:badNonce' &&
        attempt < 2
      ) {
        continue;
      }

      return this.check(result);
    }

    fail('ACME_HTTP_ERROR', 'ACME retry attempts exhausted.');
  }

  async createAccount(email: string) {
    const result = await this.post(
      this.url(this.directory.newAccount),
      { termsOfServiceAgreed: true, contact: [`mailto:${email}`] },
      { useJwk: true },
    );
    this.kid = this.url(result.response.headers.get('location'));

    if (result.data?.status !== 'valid') {
      fail('ACME_ACCOUNT_INVALID', 'ACME account is not valid.');
    }
  }

  async poll(
    url: string,
    accepted: string[],
    pending: string[],
    initial?: AcmeResult,
  ): Promise<AcmeResult> {
    const deadline = this.now() + this.pollTimeoutMs;
    let result = initial ?? (await this.post(url, undefined, { deadline }));

    for (;;) {
      const status = result.data.status ?? 'unknown';

      if (accepted.includes(status)) {
        return result;
      }

      if (!pending.includes(status)) {
        fail('ACME_VALIDATION_FAILED', 'CA resource reached an invalid or unexpected state.');
      }

      const delay = retryDelay(result.response.headers.get('retry-after'), this.now());

      if (this.now() + delay >= deadline) {
        fail(
          'ACME_POLL_TIMEOUT',
          'CA polling deadline exceeded; retry later after checking state.',
        );
      }

      await this.sleep(delay);
      result = await this.post(url, undefined, { deadline });
    }
  }
}
