# Operations

## Multiple certificates and image-only deployment

Use [two-service Compose](../../examples/compose.multiple.yml) with site-a.env/site-b.env
and independent state-a/output-a/state-b/output-b directories. Prepare ownership first.
Run docker compose --project-directory . -f examples/compose.multiple.yml up -d --build
from the repository root. Do not overlap challenge names; apex and wildcard share one name.
For rootless Docker account for host UID mapping.
[Image-only Compose](../../examples/compose.image.yml) requires BEGET_ACME_IMAGE pointing to
an available image. Use --project-directory . -f examples/compose.image.yml consistently,
pull, test staging with run --rm beget-acme run --staging --once, then up -d.
unless-stopped restores the service after daemon restart; recovery guards and retry deadlines persist.

## Timers

The [service](../../examples/beget-acme.service) and [timer](../../examples/beget-acme.timer)
run once hourly. Create the beget-acme user, install the built project in /opt/beget-acme,
and protect /etc/beget-acme.env. Set ACME_STATE_DIR=/var/lib/beget-acme,
ACME_OUTPUT_DIR=/var/lib/beget-certificates and explicit DNS consent after panel inspection.
Prepare writable directories, verify the Node binary path, install units, daemon-reload,
and enable --now beget-acme.timer. Do not also run the continuous service.
--once returns nonzero for RENEW_RETRY_DEFERRED; the next timer invocation checks again.
Hourly scheduling can extend the effective delay. Cron can use the same absolute command;
collect stderr and monitor failures.

## Reload and monitoring

Run [reload-if-changed.sh](../../examples/reload-if-changed.sh) independently on the TLS host:

```sh
sh examples/reload-if-changed.sh /srv/certs/production/current/fullchain.pem /var/lib/beget-reload /usr/sbin/nginx -s reload
```

Schedule it every minute with reload permissions. It hashes the certificate, executes the
provided command without eval, and records success only afterwards. Failed reload is retried
on the next invocation. Keep its marker directory private; inspect abandoned locks after crashes.
Use a reload command with configuration validation appropriate to your server. No Docker
socket is needed inside the ACME container. Independent polling handles publication even if
DNS cleanup has not finished. Monitor status --check, service availability, and the certificate
actually served externally. openssl x509 -checkend 604800 -noout -in CERTIFICATE checks whether
at least a week remains. Connect failures to your monitoring system; no built-in email delivery.
Back up private state/output securely. Old certificate versions are not automatically removed.

## Proxy and trust

The ACME transport uses Node HTTPS directly; HTTP_PROXY/HTTPS_PROXY are not supported proxy
configuration for this transport. Node supports NODE_EXTRA_CA_CERTS for additional trusted CAs;
provide a readable file at process startup, mounted read-only in containers. Never disable
certificate verification. Validate corporate networking separately against staging.

## Recovery after interruption

- Before a DNS request, the journal records intent. Unsent `planned` entries are discarded safely.
- Published journal-owned TXT records are cleaned before the service attempts issuance again.
- Deletion intent is saved before the API call. A restart can confirm sustained absence even if
  the deletion response was lost. Cleanup checks all configured Beget authoritative servers,
  without waiting for recursive caches. The default stability interval is 45 seconds.
- A complete certificate pair and a pending publication marker are saved before switching
  `current`. The next issuance check validates the pair and resumes that switch without ordering
  another certificate. Partial versions without a marker are ignored.
- Account keys are flushed to a temporary file and published without replacing an existing key.
  Interrupted temporary files are unused; they are not treated as account keys.
- The operation lock is an open SQLite transaction held through `node:sqlite`. The OS releases
  it on process death, including SIGKILL; no stale-lock timeout or PID guessing is used.
  `operation.sqlite` remains on disk and must never be deleted/replaced while processes run.
  Leftover `operation-owner.json` is diagnostic metadata and cannot prevent restart.
- Recovery runs before persisted scheduling delays; it never creates a new ACME order or
  bypasses a CA retry deadline. Failed recovery retries at the configured error interval.
- An unacknowledged publication followed by empty DNS remains ambiguous: Beget may apply it later.
  Missing/corrupt journals, foreign TXT and invalid certificate pairs are never silently erased.
  The continuous service retries errors, but these cases may need operator intervention.

Keep state and output on persistent storage. Flushing files reduces partial-write risk but does
not guarantee recovery from filesystem corruption or hardware that loses acknowledged writes.

Use local storage for state (for example, a Docker bind mount backed by ext4/XFS or a local
Windows NTFS directory). SMB/NFS state directories and concurrent old/new application versions
are unsupported. If an old `operation.lock` directory remains, stop all old processes, verify
that none are using it, then remove that directory once. Do not delete `operation.sqlite`.
SQLite is bundled with the required Node version; no separate database server is needed.
On POSIX, directory entries are synced after state changes; Windows has weaker power-loss
guarantees because directory fsync is unavailable through this implementation.

## Container user and permissions

The image defaults to UID/GID 10001:10001. Compose overrides it using APP_UID/APP_GID
without rebuilding. Set bind-directory ownership on the host: Dockerfile chown does not
change mounted host directories. File-based secrets must also be readable by the selected
UID/GID; Compose does not remap ownership for file secrets.
For a continuous staging service, set ACME_ENVIRONMENT=staging so the service and healthcheck
use the same environment. Healthcheck can fail until the first certificate is issued.
