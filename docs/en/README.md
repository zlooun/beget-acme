# Beget ACME

Automatically issue and renew Let's Encrypt certificates for domains using Beget DNS.
Supports domains, subdomains and wildcards; runs locally or in Docker without root.
One instance manages one certificate containing multiple names.

[Русский](../../README.md) · [Docker Hub](https://hub.docker.com/r/zloun/beget-acme) · [Releases](https://github.com/zlooun/beget-acme/releases) · [Issues](https://github.com/zlooun/beget-acme/issues)

The project author maintains `zloun/beget-acme` for Linux `amd64` and `arm64`.
This is an independent project, not an official Beget product or a Docker Official Image.

- [Quick start](#quick-start): [Docker Compose](#docker-compose) or [locally](#local-installation).
- [Certificates and automatic renewal](#certificates-and-automatic-renewal).
- [Commands and help](#commands-and-help).
- [Configuration](#configuration).
- [Common use cases](#common-use-cases).
- [Troubleshooting](#troubleshooting) and [upgrading](#upgrading).

## Quick start

You need a domain managed by Beget DNS, API access, and outbound connectivity to Beget,
Let's Encrypt and DNS servers. Issuance does not require inbound ports 80/443:
domain ownership is verified using temporary TXT records (DNS-01).

> **Before first issuance:** Beget replaces all records at each target DNS name.
> For `example.com` and `*.example.com`, inspect `_acme-challenge.example.com` in the panel:
> it must be empty and dedicated to this application. For `api.example.com`, inspect
> `_acme-challenge.api.example.com`. The `--accept-dns-replacement` flag confirms that inspection.
> Do not run another ACME client for the same challenge names concurrently.

Choose one installation method below. Both need this minimal `.env` file in the working directory:

```dotenv
BEGET_USERNAME=your_api_login
BEGET_PASSWORD='your_api_password'
ACME_EMAIL=admin@example.com
ACME_DOMAINS=example.com,*.example.com
```

Replace the values with your own. Single quotes help preserve `$` and `#` in a password
when Compose reads it. Keep `.env` private and readable only by the required user.
The wildcard `*.example.com` covers neither `example.com` itself nor `api.dev.example.com`.

### Docker Compose

Requires Docker with Compose v2. No Node.js installation or source build is needed.
These commands target Linux; a NAS interface can create the same files and directories.

**1. Prepare a working directory and Compose file.**

```sh
mkdir beget-acme
cd beget-acme
curl -fsSL https://raw.githubusercontent.com/zlooun/beget-acme/v0.2.0/examples/compose.image.yml -o compose.yaml
```

Alternatively, save the [published-image Compose example](../../examples/compose.image.yml)
as `compose.yaml`. Create `.env` next to it with the four settings above, then add:

```dotenv
BEGET_ACME_IMAGE=zloun/beget-acme:0.2.0
```

**2. Create directories and set permissions.** The container defaults to user `10001:10001`:

```sh
mkdir -p state output
sudo chown 10001:10001 state output
sudo chmod 700 state
sudo chmod 750 output
chmod 600 .env
```

For a different user, set `APP_UID` and `APP_GID` in `.env` and use those same IDs when
setting ownership. Check ACLs on NAS systems and host ID mapping for rootless Docker.
[More about permissions](OPERATIONS.md#container-user-and-permissions).

**3. Test issuance in staging.** Test certificates are not intended for browser use:

```sh
docker compose pull
docker compose run --rm beget-acme run --staging --once --accept-dns-replacement
```

Wait for successful issuance and DNS cleanup. If the command fails, see
[troubleshooting](#troubleshooting) before continuing.

**4. Start the production service.** After inspecting the DNS names in the panel, add to `.env`:

```dotenv
ACME_ACCEPT_DNS_REPLACEMENT=yes
```

Then start the container:

```sh
docker compose up -d
docker compose logs -f beget-acme
```

The image runs `run` by default: it issues a missing certificate and stays running to renew
automatically. No preliminary `run --once` or separate `setup` is required. The environment
variable authorizes DNS replacement without interactive input. Pressing `Ctrl+C` while
following logs does not stop the container.

**Optional alternative:** to wait for the first production issuance in the terminal without
setting this variable, run:

```sh
docker compose run --rm beget-acme run --once --accept-dns-replacement
```

After successful completion, start `docker compose up -d`. Production approval has been saved,
so the service no longer needs the consent flag or variable. Do not run `run --once`
alongside the persistent service.

### Local installation

Requires Git and the Node.js version in [.node-version](../../.node-version), currently `24.22.1`.
The `node` and `npm` commands also work in Windows PowerShell.

**1. Get the source and build:**

```sh
git clone --branch v0.2.0 --depth 1 https://github.com/zlooun/beget-acme.git
cd beget-acme
npm ci
npm run build
```

**2. Create `.env`** with the four settings above. Alternatively, run `node dist/cli.js init`
to create an extended template and edit it; existing files are never overwritten.
The application creates `state` and `output` in the current directory, which must be writable
by its user. On Linux, restrict `.env` permissions with `chmod 600 .env`.

**3. Test staging, then start production:**

```sh
node --env-file=.env dist/cli.js run --staging --once --accept-dns-replacement
```

After successful completion:

```sh
node --env-file=.env dist/cli.js run --accept-dns-replacement
```

`run` stays in the foreground and renews when needed. To keep it running after closing
the terminal, use Docker or [systemd](OPERATIONS.md#timers).
A separate `setup` command is not needed for this quick start.

## Certificates and automatic renewal

With default settings, files are saved under your working directory:

```text
output/
  production/current/
    fullchain.pem    # Certificate and intermediate chain
    privkey.pem      # Private key
  staging/current/   # Test certificates, separate from production
state/               # Account keys, approvals and recovery state
```

Configure your TLS server to use `fullchain.pem` and `privkey.pem`, and arrange a reload
after renewal. For containers, mount **the entire `output` directory read-only**, not just
`current` or individual PEM files: the application switches `current` to each new certificate version.
[Complete Nginx example](NGINX.md).

After a successful check, the application waits **12 hours**. It renews when less than
**one third of the actual certificate lifetime** remains, for example, under 30 days out of 90.
After an operational failure, it retries in **1 hour**, with no parallel timer or attempt limit.
A longer CA retry delay takes precedence.

State and the next check time survive restarts. On startup, the service first attempts
to recover interrupted work. Foreign DNS records or ambiguous API results may require
operator intervention: retries do not bypass safety checks.

## Commands and help

Help needs no configuration or credentials:

```sh
docker run --rm zloun/beget-acme:0.2.0 --help
node dist/cli.js --help
```

Choose the command matching your installation. `help` and `-h` also work.
For regular commands, use one of these prefixes:

```sh
docker compose run --rm beget-acme <command> [options]
node --env-file=.env dist/cli.js <command> [options]
```

**Issuance and renewal**

| Command                       | Behavior                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `run`                         | Issue a missing certificate or renew if needed, then keep running; the default command |
| `run --once`                  | Issue or renew if needed, finish DNS cleanup and exit                                  |
| `schedule`                    | Automatically renew an existing production certificate; no initial issuance            |
| `schedule --once`             | Renew an existing production certificate if needed, finish DNS cleanup and exit        |
| `issue [staging\|production]` | Issue or renew if needed and exit; defaults to staging                                 |
| `renew [staging\|production]` | Renew an existing certificate if needed and exit; defaults to production               |

A valid matching certificate outside its renewal window is kept, including with `issue`.
`run` and `schedule` include recovery of interrupted work and retry scheduling;
`issue` and `renew` are individual operations without that service loop.

**Diagnostics and maintenance**

| Command            | Behavior                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `status`           | Read-only certificate expiry, recovery and lock status                                   |
| `doctor` / `probe` | Inspect Beget and DNS without changes; `probe` is an alias                               |
| `setup`            | Inspect DNS and save approval locally; no DNS writes or ACME orders                      |
| `cleanup`          | Remove journal-owned DNS records and update the journal using the original configuration |
| `journal-clear`    | Emergency journal archival after empty-DNS checks and explicit operator confirmation     |
| `init`             | Create a template `.env` without overwriting an existing file                            |
| `help`             | Show built-in help                                                                       |

**Flags**

| Flag                       | Commands                                                                | Purpose                                                                                |
| -------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `--once`                   | `run`, `schedule`                                                       | Complete one cycle as needed and exit instead of starting the next                     |
| `--staging`                | `run`, `setup`, `status`, `doctor`, `probe`, `cleanup`, `journal-clear` | Use the test environment                                                               |
| `--accept-dns-replacement` | `run`, `schedule`, `setup`                                              | Confirm manual inspection of dedicated DNS names                                       |
| `--dry-run`                | `issue`                                                                 | DNS preflight without an account, order or DNS writes; requires approved configuration |
| `--check`                  | `status`                                                                | Exit nonzero if the selected environment is not ready                                  |
| `--json`                   | All commands emitting log events                                        | JSON events; errors use stderr. Help and version remain plain text                     |
| `--version`, `-V`          | Standalone                                                              | Print the version and exit                                                             |
| `--help`, `-h`             | Standalone or with a command                                            | Show general help and exit without executing the command                               |

`--once` **is not a read-only check**: it waits for DNS propagation, CA processing and cleanup
within the current cycle. If issuance is unnecessary, it exits without a new order.
On failure it exits nonzero instead of waiting for another cycle. It respects a persisted
retry delay from a previous failure, returning `RENEW_RETRY_DEFERRED` until that deadline.
This makes it suitable for both one-time issuance and external schedulers.

Flags may precede or follow the command. `issue` and `renew` take a positional environment,
such as `issue staging` or `renew production`, not `--staging`. `schedule` always uses production.
Other environment-aware commands use `ACME_ENVIRONMENT` (production by default) or `--staging`.

Everyday operation usually needs only `run`, `status` and `doctor`.
[Command requirements and emergency operations](CONFIGURATION.md#commands-and-modes).

## Configuration

Only the four quick-start settings are required; the published-image Compose example also
requires `BEGET_ACME_IMAGE`. Change other settings only when needed.

| Variable                           | Default               | Purpose                                                      |
| ---------------------------------- | --------------------- | ------------------------------------------------------------ |
| `ACME_DOMAINS`                     | Required              | Comma-separated names in one certificate, up to 100          |
| `ACME_EMAIL`                       | Required              | ACME account contact email                                   |
| `BEGET_USERNAME`, `BEGET_PASSWORD` | Required              | Beget API credentials                                        |
| `ACME_RENEW_BEFORE_DAYS`           | One third of lifetime | Renew when fewer than this many days remain                  |
| `ACME_SCHEDULE_INTERVAL_MS`        | `43200000` (12 h)     | Delay after a successful check                               |
| `ACME_RETRY_INTERVAL_MS`           | `3600000` (1 h)       | Delay after an operational failure                           |
| `ACME_ENVIRONMENT`                 | `production`          | Set `staging` for a persistent test service                  |
| `ACME_PRIVATE_KEY_MODE`            | `0600`                | Use `0640` for a configured shared group to read the key     |
| `ACME_ACCEPT_DNS_REPLACEMENT`      | Unset                 | `yes` replaces the initial consent flag for `run`/`schedule` |

For example, to renew with less than 10 days remaining:

```dotenv
ACME_RENEW_BEFORE_DAYS=10
```

Omitting this setting retains the automatic one-third threshold. Do not set a threshold
longer than the certificate lifetime: it would renew on every successful check.

**Paths and users depend on how you run the application:**

| Deployment             | Variables                           | Defaults              |
| ---------------------- | ----------------------------------- | --------------------- |
| Local                  | `ACME_STATE_DIR`, `ACME_OUTPUT_DIR` | `./state`, `./output` |
| Compose host paths     | `STATE_DIR`, `CERTIFICATES_DIR`     | `./state`, `./output` |
| Compose container user | `APP_UID`, `APP_GID`                | `10001`, `10001`      |

Compose sets `/state` and `/output` inside the container; host paths may be absolute.
After editing `.env`, recreate the service with `docker compose up -d` or restart the local
process. Prepare directories and permissions before switching paths.

[Full reference](CONFIGURATION.md): secret files, explicit `BEGET_ZONES`, DNS servers and
timeouts, cleanup stability and TLS fallback TTL.

## Common use cases

### A single domain, wildcard or multiple names

| Use case                               | `ACME_DOMAINS`                      |
| -------------------------------------- | ----------------------------------- |
| One site                               | `example.com`                       |
| Base domain and first-level subdomains | `example.com,*.example.com`         |
| Selected services only                 | `api.example.com,files.example.com` |
| Multiple domains in one certificate    | `example.com,example.net`           |

All zones must be accessible through the configured Beget account. Discovery is automatic;
set `BEGET_ZONES` if needed. Use punycode for IDNs. CNAME delegation of challenge names is
unsupported. Before changing domains, finish recovery with the original configuration and
stop the service; the new scope requires new approval.

### Nginx with automatic certificate reload

The [Nginx guide](NGINX.md) includes Compose, HTTPS configuration and a watcher script.
It checks `current` every hour and reloads only when the version changes. If ACME and Nginx
use different users, configure a shared TLS group, directory traversal permissions and
`ACME_PRIVATE_KEY_MODE=0640`. Adjust permissions of existing keys separately.
The ACME service itself does not restart Nginx.

### Independent certificates

Run one instance per certificate, each with its own `.env`, `state` and `output`.
Do not overlap challenge names: `example.com` and `*.example.com` use the same name.
See the [two-service example](../../examples/compose.multiple.yml) and
[instructions](OPERATIONS.md#multiple-certificates-and-image-only-deployment).

### Cron, systemd and secret files

Use `run --once` with an external scheduler, without a concurrent persistent `run`.
It returns an error if a check fails or the saved retry time has not arrived yet.
[Systemd and cron examples](OPERATIONS.md#timers).

Instead of storing a password in `.env`, use `BEGET_PASSWORD_FILE` and optionally
`BEGET_USERNAME_FILE`. Do not set both the value and the file for a credential.
[Secret file configuration](CONFIGURATION.md#secret-files).

## Troubleshooting

For Docker, after starting the service:

```sh
docker compose logs --tail 100 beget-acme
docker compose exec beget-acme node dist/cli.js status --check
docker compose exec beget-acme node dist/cli.js doctor
```

If the service is not running, use `docker compose run --rm beget-acme status --check`
or `docker compose run --rm beget-acme doctor`. Locally:

```sh
node --env-file=.env dist/cli.js status --check
node --env-file=.env dist/cli.js doctor
```

Add `--staging` to inspect the test environment.

| Symptom                            | What to check                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `CONFIG_DOMAIN_REQUIRED`           | Pass `.env` to the application using Compose `env_file` or `node --env-file`                          |
| `Permission denied`                | UID/GID, file and directory traversal permissions, NAS ACLs, TLS server access to the key             |
| `OPERATION_LOCKED`                 | Look for another instance using the same state; do not remove lock files                              |
| `getData inventory unavailable`    | The API did not return an inventory; it does not prove emptiness. Inspect the exact name in the panel |
| DNS checks or cleanup keep running | Wait for propagation; cleanup requires 45 seconds of stable absence on the configured Beget NS        |
| No new logs after startup          | Check the logged next-check time: the service may be waiting for a persisted deadline                 |

`status --check` checks the certificate and application state, not site availability.
The container may be `unhealthy` before first issuance. Do not delete the journal to bypass
unfinished work: see [recovery and its limits](OPERATIONS.md#recovery-after-interruption).

## Upgrading

Back up `state` and `output`, preserving links, ownership and permissions.
For Docker, choose a tag from [releases](https://github.com/zlooun/beget-acme/releases),
update `BEGET_ACME_IMAGE` in `.env`, then run:

```sh
docker compose pull beget-acme
docker compose up -d beget-acme
docker compose logs --tail 100 beget-acme
```

Keep state: it contains account keys and recovery data. Store it on a local filesystem,
not SMB/NFS. Never run old and new versions concurrently on the same state.
See [CHANGELOG](../../CHANGELOG.md) for changes between versions.

## Documentation and contributing

- [Full configuration](CONFIGURATION.md), [operations and recovery](OPERATIONS.md), [architecture (Russian)](../ru/ARCHITECTURE.md).
- [Security](../../SECURITY.md) and [bug reports](https://github.com/zlooun/beget-acme/issues). Never include passwords or private keys.
- [Development](../../CONTRIBUTING.md): `npm run check`, `npm run package:check`; test the Docker Nginx example with `npm run test:nginx`.
- Licensed under [MIT](../../LICENSE).
