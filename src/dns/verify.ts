import { checkRunning, pause } from '../core/shutdown.js';
import { errorCode, strings } from '../core/validation.js';
import { createLogger } from '../core/logger.js';
import type { Logger } from '../core/logger.js';

export interface DnsRecords {
  TXT?: string[];
  [type: string]: unknown[] | undefined;
}
export interface DnsRow {
  server: string;
  records: DnsRecords;
}
export interface DnsResolver {
  resolve(name: string, type: string): Promise<unknown[]>;
  cancel?(): void;
  setServers?(servers: string[]): void;
}
export type DnsQuery = (
  name: string,
  servers: readonly string[],
  types: readonly string[],
) => Promise<DnsRow[]>;
interface WaitOptions {
  name: string;
  authoritative: string[];
  recursive?: string[];
  expected: string[];
  timeoutMs: number;
  stableMs?: number;
  permittedStale?: string[];
  query?: DnsQuery;
  logger?: Logger;
  intervalMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  types?: readonly string[];
}
import { Resolver, lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError, fail } from '../core/errors.js';

/** This list is deliberately not claimed to be an exhaustive DNS-zone inventory. */
export const PREFLIGHT_TYPES = Object.freeze([
  'A',
  'AAAA',
  'MX',
  'TXT',
  'CNAME',
  'NS',
  'SRV',
  'CAA',
]);
const EMPTY_CODES = new Set(['ENOTFOUND', 'ENODATA']);

async function limit<T>(promise: Promise<T>, ms: number, subject: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new AppError('DNS_QUERY_TIMEOUT', `${subject} timed out after ${ms}ms.`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Keep nameserver addresses bounded in time in long-running schedulers. */
export function createServerResolver(
  lookupIPv4: (server: string) => Promise<{ address: string }> = (server) =>
    lookup(server, { family: 4 }),
  now = Date.now,
  ttlMs = 3600000,
) {
  const cache = new Map<string, { address: string; expires: number }>();

  return async (server: string): Promise<string> => {
    if (isIP(server)) {
      return server;
    }

    const cached = cache.get(server);

    if (cached && cached.expires > now()) {
      return cached.address;
    }

    try {
      const result = await limit(lookupIPv4(server), 8000, `DNS lookup for ${server}`);
      cache.set(server, { address: result.address, expires: now() + ttlMs });

      return result.address;
    } catch (cause) {
      throw new AppError('DNS_NS_LOOKUP_FAILED', `Cannot resolve nameserver ${server}.`, { cause });
    }
  };
}

const resolveServer = createServerResolver();

/** Query each nameserver independently; no OS-default resolver for record queries. */
export async function queryServers(
  name: string,
  servers: readonly string[],
  types: readonly string[] = PREFLIGHT_TYPES,
  resolverFactory?: (server: string) => DnsResolver | Promise<DnsResolver>,
): Promise<DnsRow[]> {
  return Promise.all(
    servers.map(async (server) => {
      const resolver = resolverFactory
        ? await limit(Promise.resolve(resolverFactory(server)), 8000, `Resolver ${server}`)
        : new Resolver({ timeout: 3000, tries: 2 });

      if (!resolverFactory) {
        resolver.setServers?.([await resolveServer(server)]);
      }

      const records: DnsRecords = Object.create(null) as DnsRecords;

      try {
        for (const type of types) {
          try {
            const values = await limit(resolver.resolve(name, type), 7000, `DNS ${server} ${type}`);

            if (type === 'TXT') {
              records.TXT = values.map((parts: unknown) =>
                strings(parts, 'DNS_BAD_RESPONSE').join(''),
              );
              continue;
            }

            records[type] = values;
          } catch (error) {
            if (!EMPTY_CODES.has(errorCode(error) ?? '')) {
              throw new AppError(
                'DNS_QUERY_FAILED',
                `DNS ${server} ${type} failed (${errorCode(error) ?? 'timeout'}).`,
                {
                  hint: 'Check name server reachability, then retry read-only doctor.',
                  cause: error,
                },
              );
            }

            records[type] = [];
          }
        }

        return { server, records };
      } finally {
        resolver.cancel?.();
      }
    }),
  );
}

export function assertEmpty(rows: DnsRow[]) {
  for (const { server, records } of rows) {
    for (const [type, values] of Object.entries(records)) {
      if (values?.length) {
        fail(
          'DNS_ZONE_NOT_EMPTY',
          `${server} reports ${values?.length} ${type} record(s).`,
          'Use a dedicated, empty DNS name. Never let this tool overwrite existing records.',
        );
      }
    }
  }
}

/** Distinguish ordinary propagation lag from the appearance of foreign records. */
export function assertExactTXT(
  rows: DnsRow[],
  expected: string[],
  { permittedStale = [] }: { permittedStale?: string[] } = {},
) {
  const want = new Set(expected);
  const permitted = new Set([...expected, ...permittedStale]);

  for (const { server, records } of rows) {
    for (const [type, values] of Object.entries(records)) {
      if (type !== 'TXT' && values?.length) {
        fail(
          'DNS_FOREIGN_RECORD',
          `${server} reports unexpected ${type} record(s).`,
          'Do not retry changes; inspect DNS manually.',
        );
      }
    }

    const found = records.TXT ?? [];

    if (found.some((value) => !permitted.has(value))) {
      fail(
        'DNS_FOREIGN_TXT',
        `${server} reports TXT values that are not in this operation journal.`,
        'Stop. The tool will not remove TXT records belonging to another process.',
      );
    }

    if (
      found.length !== want.size ||
      new Set(found).size !== want.size ||
      found.some((value) => !want.has(value))
    ) {
      fail('DNS_NOT_PROPAGATED', `${server}: ${found.length} TXT visible, ${want.size} expected.`);
    }
  }
}

/** Poll while enforcing total elapsed time and a continuous stability interval. */
export async function waitForTXT({
  name,
  authoritative,
  recursive = [],
  expected,
  timeoutMs,
  stableMs = 0,
  permittedStale = [],
  query = queryServers,
  logger = createLogger(),
  intervalMs = 15000,
  signal,
  now = Date.now,
  sleep: wait = (ms) => pause(ms, signal),
  types = ['TXT'],
}: WaitOptions): Promise<void> {
  const startedAt = now();
  const stopAt = startedAt + timeoutMs;
  const phase = expected.length ? 'DNS publication' : 'DNS cleanup';
  let stableSince: number | null = null;
  let attempt = 0;
  logger.info(
    `${phase}: waiting for ${expected.length} TXT record(s) at ${name}. ` +
      `All ${authoritative.length} authoritative and ${recursive.length} recursive servers must agree ` +
      `for ${Math.ceil(stableMs / 1000)}s. Timeout: ${Math.ceil(timeoutMs / 1000)}s; ` +
      `pause between DNS checks: ${Math.ceil(intervalMs / 1000)}s. These checks do not create ACME orders.`,
  );

  logger.info(
    `${phase}: authoritative servers: ${authoritative.join(', ')}; recursive resolvers: ${recursive.join(', ') || 'none'}.`,
  );

  if (!expected.length) {
    logger.info(
      'DNS cleanup: waiting for stable absence of records. These checks only read DNS; they do not send deletion requests. Old TXT answers reset the empty-state timer.',
    );
  }

  while (now() < stopAt) {
    checkRunning(signal);
    attempt++;
    let serverGroup = 'authoritative';

    try {
      const auth = await query(name, authoritative, types);
      assertExactTXT(auth, expected, { permittedStale });

      if (recursive.length) {
        serverGroup = 'recursive';
        const rec = await query(name, recursive, types);
        assertExactTXT(rec, expected, { permittedStale });
      }

      checkRunning(signal);

      if (now() >= stopAt) {
        break;
      }

      stableSince ??= now();
      const stableFor = now() - stableSince;
      logger.info(
        `${phase}: check ${attempt}, all servers agree; stable ${Math.floor(stableFor / 1000)}/${Math.ceil(stableMs / 1000)}s; ` +
          `elapsed ${Math.floor((now() - startedAt) / 1000)}s.`,
      );

      if (stableFor >= stableMs) {
        logger.info(`${phase}: stability requirement met for ${name}.`);

        return;
      }
    } catch (error) {
      checkRunning(signal);

      if (errorCode(error) === 'DNS_FOREIGN_TXT' || errorCode(error) === 'DNS_FOREIGN_RECORD') {
        throw error;
      }

      const reset = stableSince !== null;
      stableSince = null;
      // Only this locally generated error contains safe server/count diagnostics.
      const reason =
        error instanceof AppError && error.code === 'DNS_NOT_PROPAGATED'
          ? error.message
          : (errorCode(error) ?? 'DNS_ERROR');
      logger.info(
        `${phase}: check ${attempt}, ${serverGroup} DNS not ready: ${reason} ` +
          `${reset ? 'Stability timer reset.' : 'Stability timer has not started.'} ` +
          `Elapsed ${Math.floor((now() - startedAt) / 1000)}s.`,
      );
    }

    await wait(Math.min(intervalMs, Math.max(1, stopAt - now())));
  }

  fail(
    'DNS_PROPAGATION_TIMEOUT',
    `TXT at ${name} did not stabilize within ${timeoutMs / 1000}s.`,
    'Run `status` and `doctor` before any new issuance. Keep the recovery journal.',
  );
}
