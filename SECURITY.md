# Security and recovery

## DNS permissions and limits

Beget `changeRecords` replaces all record types at a name. Only dedicated, empty
challenge names explicitly confirmed by the operator are allowed. The application
checks the selected managed zone, the readable provider inventory and each configured
authoritative server. These checks cannot enumerate every DNS record type, prevent
concurrent external writers, or prove the absence of a delayed provider mutation.
Do not share these names with another ACME client. CNAME delegation is not supported.

Missing provider record inventories and `METHOD_FAILED` mean **unknown**, not empty.
Explicit name confirmation also acknowledges manual panel inspection in that case.
Public resolvers learn the names queried; configure your own resolvers when appropriate.

## Secrets and filesystem

Keep `.env`, `state`, `output`, and `secrets` private. Secret files support a leading
UTF-8 BOM; their spaces are preserved. Credentials are sent in HTTPS POST bodies and
must not appear in logs, screenshots, issue reports, or shell history. Prefer `*_FILE`
and read-only secret mounts. Run the container without root, with restricted host ownership.

Keys default to `0600`; `0640` requires a deliberately configured shared group. Windows
uses host ACLs. Backups contain private keys and require the same protection as live state.
If a key or credential is actually exposed, rotate it and assess certificate revocation.
Preserve account keys and recovery journals in secure persistent storage. Package allowlists
exclude runtime state and secrets.

## Normal recovery

1. Stop competing instances. Run `status` and `doctor`.
2. Inspect every journal name in the provider panel and on authoritative DNS.
3. Run `cleanup` with the original zones, confirmations and nameservers.

Cleanup removes a record set only when all authoritative servers show exactly the
journal-owned values and the readable panel contains no foreign records. It then waits
for stable absence. A failed or interrupted request retains recovery state. Never remove
foreign records to make a test pass. Keep old configuration until recovery is complete.

`SIGTERM`/`SIGINT` cancel new requests and waits; locks are released after work unwinds.
An exclusive SQLite transaction holds the OS file lock; process death releases it without
requiring a stale-PID or age heuristic. Keep state on a local filesystem; SMB/NFS is unsupported.
Never remove or replace `operation.sqlite` while any process may run: that could create two
independent lock targets. Owner metadata is diagnostic, not proof of ownership.
An old `operation.lock` directory requires a one-time inspection with all old processes stopped;
old and new versions must not run concurrently against the same state.

## Emergency journal archival

Use `journal-clear` only when normal cleanup refuses an uncertain mutation and you have
confirmed the provider's final state. Stop other clients, inspect the panel, and allow time
for provider processing and DNS propagation. A network response lost before acknowledgement
can hide a successful write; empty observations cannot rule out delayed writes.

Set these environment variables for a single command:

```dotenv
ACME_CONFIRM_JOURNAL_CLEAR=_acme-challenge.example.com,_acme-challenge.api.other.net
ACME_JOURNAL_CLEAR_REASON=Provider panel verified empty after propagation and manual inspection
```

The names must exactly match **all remaining entries** in the journal. Run:

```sh
node --env-file=.env dist/cli.js journal-clear
```

The command checks normal write authorization, zone control, provider inventory and stable
empty DNS for the configured record types. If the panel inventory is unreadable, your exact
confirmation is the manual attestation. The original journal and reason are saved under
`state/recovery-archive` before the active journal is removed. No DNS mutation occurs.
Remove the emergency environment variables afterwards. This is an operator override,
not proof that a provider cannot apply an old request later.

## Reporting vulnerabilities

Do not include credentials, private keys, tokens or raw provider responses in public issues.
Use private vulnerability reporting on the hosting repository when available; otherwise
arrange a private channel with maintainers before sharing sensitive details.

## Saved setup approval

`setup` replaces manual challenge-name lists with explicit approval of the displayed
scope. It performs read-only network checks and writes local approval state, not DNS.
`--accept-dns-replacement` is an explicit operator attestation of panel inspection,
not a bypass of preflight. Protect `state/setup.json` like other operational state.
Stop the service before changing configuration. Recover pending DNS using the original
configuration before approving a new scope. For staging-only approval use
`cleanup --staging` and `journal-clear --staging`; production approval is separate.
New image builds and the basic Compose examples default to root (UID/GID 0:0).
For persistent deployments, prefer a dedicated non-root user: set both APP_UID/APP_GID
in Compose or use docker run --user, and prepare writable directories with matching ownership.
Keep explicit IDs when upgrading existing non-root deployments. Stop and back up before
changing ownership of existing state/output; startup never performs automatic chown.
Compose creates missing bind directories; root-created files on an ordinary Docker host
belong to root. Existing filesystem permissions and NAS ACLs still apply.
Both Compose modes retain a read-only root filesystem, dropped capabilities and
no-new-privileges. Running the Docker daemon rootless is a separate host configuration.
No Docker socket or privileged startup helper is needed.

## One-command startup

run/schedule can perform setup inline using --accept-dns-replacement or
ACME_ACCEPT_DNS_REPLACEMENT=true (default: false). False/unset does not grant new approval
but does not revoke matching saved approval. Explicit yes authorizes the selected environment and
configured scope; it can approve a changed scope on a later start. Do not enable it globally
for untrusted configuration. Pending recovery still prevents replacing approval. It does not
bypass provider/DNS checks or overwrite corrupt approval. Without this consent, matching
saved setup is required for run.

Interrupted cleanup records deletion intent before contacting Beget. Only previously
observed journal-owned records can enter that recovery phase; empty DNS by itself is
not proof that an earlier unacknowledged publication will never appear. Cleanup checks
all configured authoritative servers for sustained absence, without relying on recursive
cache expiry. Recovery never authorizes deletion of unknown records.

Certificate recovery validates regular local version files, matching keys, exact SANs and
validity within the selected environment. It can restore a missing/broken pointer without a
marker. An invalid marker is preserved in quarantine only when a valid local pair exists;
otherwise recovery fails closed. Access errors never trigger replacement. These checks do not
authenticate arbitrary files placed by an attacker with output write access: protect that
directory and restore only trusted backups. Preserve output alongside state during recovery.

Existing account keys must be regular files, at most 64 KiB, with owner-only permissions on
POSIX; symbolic links and RSA keys below 2048 bits are refused. Windows access is controlled
by ACLs. Invalid keys are never silently replaced. Beget response bodies are bounded to 1 MiB
and share the request deadline. DNS preflight also checks NAPTR and PTR, but cannot enumerate
every possible provider record type: panel inspection remains necessary.
