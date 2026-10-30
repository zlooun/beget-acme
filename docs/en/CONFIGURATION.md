# Configuration and advanced commands

Required: `ACME_DOMAINS` (exact comma-separated SAN list, up to 100), `ACME_EMAIL`,
`BEGET_USERNAME`, `BEGET_PASSWORD`. `ACME_ENVIRONMENT` defaults to production; use staging
for a persistent test service. Optional `BEGET_ZONES` overrides API-based discovery.

Native paths: `ACME_STATE_DIR=./state`, `ACME_OUTPUT_DIR=./output`. Compose host paths:
`STATE_DIR=./state`, `CERTIFICATES_DIR=./output`; container paths remain `/state`, `/output`.
Compose UID/GID default to `10001:10001` and can be changed with `APP_UID`/`APP_GID`.

Setup approval is separate for staging/production and bound to domains, explicit zones,
nameservers, login. Passwords are never stored in setup; password rotation
does not require DNS approval again. Changing certificate directories requires write access,
but not new DNS authorization.

## Secret files

Use `BEGET_USERNAME_FILE` and `BEGET_PASSWORD_FILE` instead of direct values. Do not set both
forms for one credential. Leading UTF-8 BOM and trailing newlines are removed; spaces stay.
Quote `.env` values containing `#`. See [Compose secrets](../../examples/compose.secrets.yml).
Remove inline credentials, create restricted `secrets/username.txt` and `secrets/password.txt`
readable by the container UID/GID, then use both files for every Compose command:

```sh
docker compose -f docker-compose.yml -f examples/compose.secrets.yml run --rm beget-acme setup
```

File-backed Compose secrets still require host filesystem and backup protection.

## Advanced settings

| Variable                    | Default            | Purpose                                        |
| --------------------------- | ------------------ | ---------------------------------------------- |
| `BEGET_NAMESERVERS`         | Four Beget servers | Authoritative DNS checks                       |
| `ACME_PUBLIC_RESOLVERS`     | `1.1.1.1,9.9.9.9`  | Recursive DNS; these servers see queried names |
| `ACME_DNS_TIMEOUT_MS`       | `900000`           | Timeout per DNS name                           |
| `ACME_CLEANUP_SETTLE_MS`    | `45000`            | Continuous absence after cleanup               |
| `ACME_RENEW_BEFORE_DAYS`    | unset              | One third of lifetime or explicit days         |
| `ACME_RETRY_INTERVAL_MS`    | `3600000`          | Failure interval, 60000–86400000 ms            |
| `ACME_SCHEDULE_INTERVAL_MS` | `43200000`         | Pause between successful checks                |
| `ACME_PRIVATE_KEY_MODE`     | `0600`             | Optional `0640` for a configured shared group  |

Timeout must exceed the cleanup stability interval by more than 30 seconds. Synchronize host clocks.
CNAME delegation is unsupported. `--json` works globally; errors use stderr. Flags can precede
or follow commands. `run --once` supports cron/systemd timers. `issue staging --dry-run` checks
DNS without orders or mutations. `init` never overwrites
`.env`; `--version` prints the package version.

## Scheduler

One sequential loop waits ACME_SCHEDULE_INTERVAL_MS (12 hours) after success and
ACME_RETRY_INTERVAL_MS (1 hour) after any operational failure. CA Retry-After can extend
the delay. There is no attempt limit. Mode and next check time persist across restarts.
Pending DNS recovery is attempted safely before issuance; foreign records and uncertain
mutations are never bypassed. Recovery failure leaves the service running and waiting.
--once makes one attempt and returns errors to an external scheduler, including deferred retries.
An unset ACME_RENEW_BEFORE_DAYS uses one third of actual certificate lifetime; an explicit
value is used exactly. Renew when remaining lifetime is less than the threshold. A threshold
longer than certificate lifetime causes renewal on each normal check; choose it deliberately.

## ACME TLS compatibility

ACME uses Node HTTPS with TLS 1.2–1.3. A connection timeout (10 seconds), reset or
selected negotiation errors before the handshake completes trigger one TLS 1.2-only
retry. Both attempts share the overall request deadline and cancellation signal.
Server certificate verification remains mandatory. Certificate/DNS errors, HTTP
responses and failures after the handshake do not trigger fallback. Beget retains
its existing transport. A fallback warning does not prove TLS 1.3 caused the failure.

A successful TLS 1.2 fallback is remembered per ACME host in `state/tls/`, including
across restarts. Failed fallback is not remembered. To reset, stop the service and
remove only that host preference file. Staging/production hosts are independent.
DNS checks use exactly BEGET_NAMESERVERS (four .com/.pro servers by default), not
every possible Beget NS. Changing the list requires setup again after recovery.
Cleanup polling reads DNS repeatedly; it does not repeatedly delete records.

## Startup without a separate setup command

run and schedule accept --accept-dns-replacement or ACME_ACCEPT_DNS_REPLACEMENT=yes.
Consent is unset by default. It explicitly authorizes replacement at the computed DNS names
and attests panel inspection. Missing/mismatched approval triggers inline setup: directories,
managed zones, empty DNS and recovery guards. Matching approval is reused without rerunning
setup. Corrupt approval is not automatically overwritten. Pending recovery prevents changes
to the approved scope. Existing saved setup still works without the flag. Use run for initial
issuance; schedule requires an existing production certificate.
