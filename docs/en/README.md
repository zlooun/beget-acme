# Beget ACME

Issue and renew Let's Encrypt certificates through Beget DNS. One instance manages one
certificate with an exact SAN list of domains, subdomains and wildcards.
[Русский](../../README.md) · [Configuration](CONFIGURATION.md) · [Security](../../SECURITY.md)

## Minimal configuration

Copy .env.example to .env and set:

```dotenv
BEGET_USERNAME=your_api_login
BEGET_PASSWORD=your_api_password
ACME_EMAIL=admin@example.com
ACME_DOMAINS=example.com,*.example.com,api.example.com
```

Wildcards do not include the base name. Use punycode for IDNs. Managed zones are discovered
through Beget; BEGET_ZONES overrides discovery. CNAME delegation is unsupported.
Beget replaces all records at each target name. Inspect the computed _acme-challenge names
in the panel: they must be empty and dedicated to this client.
--accept-dns-replacement explicitly attests that inspection, including when inventory is unreadable.

## One-command native startup

Use the Node version in .node-version. Install with npm ci and build/check with npm run check.
A separate setup command is optional:

```sh
node --env-file=.env dist/cli.js run --staging --once --accept-dns-replacement
```

After staging verification, start production:

```sh
node --env-file=.env dist/cli.js run --accept-dns-replacement
```

run performs initial checks and saves approval inline, issues a missing certificate and then
checks renewal every 12 hours. --once performs one check. Matching saved approval needs no flag.
ACME_ACCEPT_DNS_REPLACEMENT=yes in .env is an alternative to the flag and authorizes the
selected environment. Enable production deliberately. Optional setup performs the checks
separately with interactive CONFIRM, without DNS writes or ACME orders. schedule supports
inline setup too, but still requires an existing production certificate; use run for first issuance.

## Docker Compose

To build from source, run docker compose build. Add to .env:

```dotenv
ACME_ACCEPT_DNS_REPLACEMENT=yes
STATE_DIR=./state
CERTIFICATES_DIR=./output
APP_UID=10001
APP_GID=10001
```

Prepare writable host directories before startup. Linux example:

```sh
mkdir -p state output
sudo chown 10001:10001 state output
sudo chmod 700 state
sudo chmod 750 output
```

Adjust paths and IDs; use ACLs on Windows. Rootless Docker requires accounting for host UID
mapping. Non-root containers and a rootless daemon are distinct. Missing bind directories
are not automatically created. The container uses a read-only rootfs, no Docker socket and
no privilege escalation. [Optional file secrets](../../examples/compose.secrets.yml).

```sh
docker compose run --rm beget-acme run --staging --once
```

After staging, start production with docker compose up -d and inspect docker compose logs -f.
For published images set BEGET_ACME_IMAGE, pull and use --no-build.

## Certificates and operation

Output: output/production/current/fullchain.pem and privkey.pem; staging uses its own directory.
Mount the entire certificate directory read-only into the TLS server so current resolves.
Reload the server separately. Keys default to 0600; optional 0640 requires a shared group and
directory access. [Nginx example](../../examples/nginx.conf).
For Docker, see [Nginx with an internal certificate watcher](NGINX.md).

Use status --staging --check and doctor --staging for test diagnostics. Health checks inspect
the selected certificate and recovery state, not the web server. Missing certificates during
first issuance make the health check fail until publication completes.

All configured authoritative and recursive servers must show the TXT values; CA validation
starts immediately afterwards. Cleanup checks only the configured Beget authoritative servers
and requires 45 seconds of stable absence. Public resolver caches do not delay cleanup.
One sequential loop waits ACME_SCHEDULE_INTERVAL_MS (12 hours) after success and
ACME_RETRY_INTERVAL_MS (1 hour) after any operational failure. CA Retry-After can extend
the delay. There is no attempt limit. Mode and next check time persist across restarts.
Pending DNS recovery is attempted safely before issuance; foreign records and uncertain
mutations are never bypassed. Recovery failure leaves the service running and waiting.
--once makes one attempt and returns errors to an external scheduler, including deferred retries.
An unset ACME_RENEW_BEFORE_DAYS uses one third of actual certificate lifetime; an explicit
value is used exactly. Renew when remaining lifetime is less than the threshold. A threshold
longer than certificate lifetime causes renewal on each normal check; choose it deliberately.
Successful TLS 1.2
fallback is remembered per CA host under state/tls/ for seven days. After expiry,
the next request allows TLS 1.3 again.

Preserve state/output on upgrades. Before changing scope, stop the service and recover with
the original configuration. Changed scope requires setup or explicit inline consent again.
Never share challenge names between competing clients. Inspect status/doctor, then cleanup
with the original configuration; add --staging for staging. Never delete journals to bypass errors.
[Recovery](../../SECURITY.md).

Development checks: npm run check and npm run package:check.

[Operations: multiple certificates, timers, reload and monitoring](OPERATIONS.md).

Store state on a local filesystem, not SMB/NFS. The OS releases the operation lock on
process death. Recovery precedes issuance scheduling without bypassing CA backoff.
See [interruption recovery](OPERATIONS.md#recovery-after-interruption).
