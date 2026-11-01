# Architecture

## Configuration and boundaries

`ACME_DOMAINS` is the exact SAN list for one certificate. Setup discovers managed zones
by asking Beget about DNS ancestors; optional `BEGET_ZONES` overrides discovery.
The longest matching confirmed zone is selected. Wildcards are allowed only as the
leftmost label. An apex and its wildcard share `_acme-challenge.<apex>`; subdomains have
their own challenge names. All configured zones must use the configured `BEGET_NAMESERVERS`.
Each instance needs separate state/output directories. CNAME delegation is unsupported.

## Modules

- `src/cli.ts`: arguments, exit codes and signal handlers.
- `src/core/config.ts`: configuration, secret, zone and allowlist validation.
- `src/core/application.ts`: issuance, DNS orchestration and recovery.
- `src/core/service.ts`: sequential scheduling, persisted retries and startup recovery.
- `src/core/response.ts`: bounded Beget response reads under the request deadline.
- `src/core/store.ts`: locks, journal, persisted retry state and certificate publication.
- `src/core/shutdown.ts`: cancellation without premature lock release.
- `src/providers/beget.ts`: Beget API and independent mutation allowlist.
- `src/dns/verify.ts`: independent server queries, stability checks, one-hour NS address cache.
- `src/acme/`: JWS, nonces, ACME v2, identifier validation and CSR generation.

External JSON is validated at the boundary. Stable error codes exclude raw provider responses.
Errors use stderr; other log events use stdout.

## Issuance and recovery

1. Check authorization, existing certificate/SANs and absence of a pending journal.
2. Preflight every challenge name before creating an ACME order.
3. Validate exact order identifiers and group TXT tokens by name.
4. Persist planned mutations; repeat preflight immediately before each name's publication.
5. Publish sequentially, recording phase before and after each request.
6. Wait for matching authoritative and recursive DNS answers; immediately validate challenges.
   Stale recursive answers are retried until the deadline; foreign authoritative records abort.
7. Check SANs, validity and matching key; publish an immutable certificate version.
8. Clean each affected name; remove an entry only after confirmed cleanup.

Version 2 journals retain the first entry at the top level and additional names in `entries`.
Phases: `planned` means not yet sent;
`prepared` means a send may have occurred; `published` means API acknowledgement;
`verified` means matching TXT visibility; `cleanup-started` records deletion intent after observing the complete owned set; `cleanup-requested` means acknowledged deletion.
Uncertain responses retain recovery state. Unsent planned entries need no DNS cleanup.
Foreign records always block deletion.

Reused authorizations can avoid DNS writes, but preflight still runs. This deliberately
rejects occupied challenge names even when the CA might otherwise issue without new TXT.
`journal-clear` is an emergency operator override: exact names, an inspection reason,
stable empty DNS and panel checks are required. It archives the journal without mutating
DNS. No observation can exclude a provider applying an old request later.

## Renewal and shutdown

One sequential loop waits ACME_SCHEDULE_INTERVAL_MS (12 hours) after success and
ACME_RETRY_INTERVAL_MS (1 hour) after any operational failure. CA Retry-After can extend
the delay. There is no attempt limit. Mode and next check time persist across restarts.
Pending DNS recovery is attempted safely before issuance; foreign records and uncertain
mutations are never bypassed. Recovery failure leaves the service running and waiting.
--once makes one attempt and returns errors to an external scheduler, including deferred retries.
An unset ACME_RENEW_BEFORE_DAYS uses one third of actual certificate lifetime; an explicit
value is used exactly. Renew when remaining lifetime is less than the threshold. A threshold
longer than certificate lifetime causes renewal on each normal check; choose it deliberately.

Shutdown cancels waits and requests; outstanding work must unwind before lock release.
DNS queries have bounded timeouts. Unknown mutations retain journals. SIGKILL is not catchable.
On Linux, `current` switches with atomic rename. Windows junction replacement is not atomic;
a previous-pointer backup is restored on a failed rename, and the pending marker permits
recovery after a crash between renames. A brief missing-pointer window remains. Account for this limitation when
using Windows as a certificate server.

## Setup and service lifecycle

`src/core/setup.ts` verifies directories, discovers zones and checks dedicated DNS names.
Explicit confirmation saves `state/setup.json`, bound to domains, requested zones,
Beget login, nameservers. Passwords are not saved there. Staging and
production approvals are separate. Every mutation still performs runtime preflight.
Stop the service before configuration changes; recover using the old configuration first.
`run` uses matching approval or performs setup inline with explicit flag/env consent,
issues a missing certificate and then checks renewal.
`run --once` performs one check; `schedule` requires an existing certificate.
Staging retry state is separate from production; the operation lock and journal are shared.

## Operation ownership

`operation.sqlite` provides process ownership through an exclusive SQLite transaction held
across awaited work. Closing the connection releases it; process termination releases the
OS lock. The persistent database is never unlinked. PID/hostname metadata is diagnostic only.
Local filesystems are required. See [SQLite locking](https://www.sqlite.org/lockingv3.html).
The service repairs pending certificate publication and DNS journals before applying saved
issuance deadlines. Recovery never submits a new ACME order; CA backoff remains in effect.
