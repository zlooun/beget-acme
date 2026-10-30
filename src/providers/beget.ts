import { AppError, fail } from '../core/errors.js';
import { object, isRecord } from '../core/validation.js';
import type { HttpTransport } from '../core/validation.js';

const API_BASE = 'https://api.beget.com/api/dns/';
const METHODS = new Set(['getData', 'changeRecords']);
export type BegetRecords = Record<string, Record<string, unknown>[]>;
export type ZoneDescription =
  { readable: true; records: BegetRecords } | { readable: false; records: null };
export interface RootZone {
  fqdn: string;
  is_beget_dns: boolean;
  is_under_control: boolean;
}
export interface BegetProvider {
  assertRootZone(domain: string): Promise<RootZone>;
  describe(name: string): Promise<ZoneDescription>;
  replaceTXT(name: string, values: string[]): Promise<void>;
}
interface BegetResponse {
  status?: unknown;
  answer: Record<string, unknown>;
  error_code?: unknown;
}

function parseResponse(value: unknown): BegetResponse {
  const data = object(value, 'BEGET_BAD_RESPONSE');

  return {
    status: data.status,
    answer: object(data.answer, 'BEGET_BAD_RESPONSE'),
    error_code: data.error_code,
  };
}

function providerError(response: BegetResponse): string {
  const errors = response.answer.errors;
  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
  const detail = isRecord(first) ? first : {};
  const candidate = detail.error_code ?? response.answer.error_code ?? response.error_code;

  // Provider responses may contain secrets; expose only a short sanitized code.
  return typeof candidate === 'string' && /^[A-Z][A-Z_0-9]{0,63}$/.test(candidate)
    ? candidate
    : 'UNKNOWN';
}

function isSuccess(response: BegetResponse): boolean {
  return response.status === 'success' && response.answer.status === 'success';
}

/** An independent allowlist protects DNS against mistakes in the caller. */
export class BegetClient implements BegetProvider {
  private readonly username: string;
  private readonly password: string;
  private readonly allowedNames: Set<string>;
  private readonly transport: HttpTransport;

  constructor({
    username,
    password,
    allowedNames,
    transport = fetch,
  }: {
    username: string;
    password: string;
    allowedNames: string[];
    transport?: HttpTransport;
  }) {
    if (!username || !password) {
      fail('BEGET_CREDENTIALS_MISSING', 'Credentials are required.');
    }

    if (!allowedNames.length || new Set(allowedNames).size !== allowedNames.length) {
      fail('BEGET_ALLOWLIST_INVALID', 'Distinct DNS names must be explicitly allowed.');
    }

    this.username = username;
    this.password = password;
    this.allowedNames = new Set(allowedNames);
    this.transport = transport;
  }

  async call(method: string, data: Record<string, unknown>): Promise<BegetResponse> {
    if (!METHODS.has(method)) {
      fail('BEGET_METHOD_DENIED', 'Unsupported Beget API method.');
    }

    const body = new URLSearchParams({
      login: this.username,
      passwd: this.password,
      input_format: 'json',
      output_format: 'json',
      input_data: JSON.stringify(data),
    });
    let response: Response;

    try {
      response = await this.transport(`${API_BASE}${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
      });
    } catch (cause) {
      throw new AppError(
        method === 'getData' ? 'BEGET_READ_RETRYABLE' : 'BEGET_NETWORK_ERROR',
        `Beget ${method} request failed.`,
        {
          hint: 'Check HTTPS connectivity. DNS mutation status may be unknown: inspect status before retrying.',
          cause,
        },
      );
    }

    if (!response.ok) {
      fail(
        method === 'getData' && (response.status === 429 || response.status >= 500)
          ? 'BEGET_READ_RETRYABLE'
          : 'BEGET_HTTP_ERROR',
        `Beget returned HTTP ${response.status}.`,
        'Check account credentials and Beget API status.',
      );
    }

    let dataJson: unknown;

    try {
      dataJson = await response.json();
    } catch (cause) {
      throw new AppError('BEGET_BAD_RESPONSE', 'Beget returned invalid JSON.', { cause });
    }

    return parseResponse(dataJson);
  }

  async assertRootZone(domain: string): Promise<RootZone> {
    const response = await this.call('getData', { fqdn: domain });

    if (!isSuccess(response)) {
      throw new AppError(
        'BEGET_ROOT_NOT_MANAGED',
        `Beget did not confirm management of ${domain} (${providerError(response)}).`,
        {
          cause:
            providerError(response) === 'METHOD_FAILED' ? 'zone-unavailable' : 'provider-error',
        },
      );
    }

    const root = object(response.answer.result, 'BEGET_BAD_RESPONSE');

    if (
      ![true, 1].includes(root.is_beget_dns as boolean | number) ||
      ![true, 1].includes(root.is_under_control as boolean | number)
    ) {
      throw new AppError(
        'BEGET_ROOT_NOT_MANAGED',
        `Beget did not confirm management of ${domain}.`,
        { cause: 'zone-not-controlled', hint: 'Check delegation, API access and domain spelling.' },
      );
    }

    return { fqdn: domain, is_beget_dns: true, is_under_control: true };
  }

  async describe(name: string): Promise<ZoneDescription> {
    const response = await this.call('getData', { fqdn: name });

    if (isSuccess(response)) {
      const result = object(response.answer.result, 'BEGET_BAD_RESPONSE');

      if (result.records === undefined || result.records === null) {
        return { readable: false, records: null };
      }

      const raw = object(
        Array.isArray(result.records) && result.records.length === 0 ? {} : result.records,
        'BEGET_BAD_RESPONSE',
      );
      const records: BegetRecords = Object.create(null) as BegetRecords;

      for (const [type, entries] of Object.entries(raw)) {
        if (!Array.isArray(entries)) {
          fail('BEGET_BAD_RESPONSE', 'Invalid DNS record list.');
        }

        records[type] = entries.map((entry: unknown) => object(entry, 'BEGET_BAD_RESPONSE'));
      }

      return { readable: true, records };
    }

    const code = providerError(response);

    if (code === 'METHOD_FAILED') {
      return { readable: false, records: null };
    }

    fail(
      'BEGET_GETDATA_FAILED',
      `Beget getData rejected ${name} (${code}).`,
      'Verify domain permissions and the DNS zone in Beget.',
    );
  }

  async replaceTXT(name: string, values: string[]): Promise<void> {
    if (!this.allowedNames.has(name)) {
      fail('DNS_NAME_NOT_ALLOWED', `Beget TXT modification is not allowed for ${name}.`);
    }

    if (
      values.length > 10 ||
      new Set(values).size !== values.length ||
      values.some((value) => !/^[-_A-Za-z0-9]{10,256}$/.test(value))
    ) {
      fail('BEGET_TXT_INVALID', 'Invalid TXT token set (maximum 10 distinct base64url tokens).');
    }

    // changeRecords replaces ALL record types at this name, including non-TXT records.
    const records = { TXT: values.map((value) => ({ priority: 10, value })) };
    const response = await this.call('changeRecords', { fqdn: name, records });

    if (!isSuccess(response) || response.answer.result !== true) {
      fail(
        'BEGET_CHANGE_FAILED',
        `Beget changeRecords rejected ${name} (${providerError(response)}).`,
        'The request may have changed DNS even if its response failed; inspect the recovery journal.',
      );
    }
  }
}
