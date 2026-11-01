# Nginx with an internal certificate watcher

This example combines the published ACME image and an `nginx-unprivileged` Alpine image.
The watcher runs inside Nginx, without cron, Docker socket access or network commands from
ACME. The standalone `reload-if-changed.sh` remains an alternative for external timers.

## Files and configuration

- [compose.image.yml](../../examples/compose.image.yml): ACME service.
- [compose.nginx.yml](../../examples/compose.nginx.yml): Nginx overlay and shared certificate group.
- [nginx.env.example](../../examples/nginx.env.example): settings for both services.
- [nginx-unprivileged.conf](../../examples/nginx-unprivileged.conf): HTTPS on container port 8443.
- [start-with-reload.sh](../../examples/start-with-reload.sh): startup and version watcher.

Run commands from the repository root with `--project-directory .`. Create `.env` from
`examples/nginx.env.example`, or merge its settings into an existing `.env`; do not overwrite
working credentials. Fill in domains, email and Beget credentials. Update `server_name` and
replace the sample HTTP response with your proxy configuration and required Docker networks.
Only the ACME service receives `.env`; Nginx receives its polling interval, not Beget credentials.

The default paths are relative to the repository root. Absolute host paths are also supported.
When copying the script through a file manager, preserve LF line endings. It is invoked with
`/bin/sh`, so executable permission is not required; read permission is required. This example
is tested with the specified Alpine image and preserves that image's original entrypoint.

## Users and permissions

This overlay explicitly uses non-root users regardless of the basic Compose root default.

Defaults: ACME UID 10001, Nginx UID/GID 10003, shared TLS GID 10002. Replace these with your
host identities. The overlay sets ACME's primary group to `TLS_GID` and adds that group to
Nginx. Numeric identities need not have matching names inside the images.

For a new installation on a conventional Linux Docker host:

```sh
mkdir -p state output
sudo chown 10001:10002 state output
sudo chmod 700 state
sudo chmod 750 output
chmod 600 .env
```

Adjust paths and IDs when changing settings. On NAS systems, ACLs must also permit traversal
and reading of the entire mounted output tree. The ACME owner needs write access; the TLS
group needs read/traverse access, including new version directories. Keep `state` private.
Rootless Docker or user namespace remapping requires matching mapped host IDs.

The overlay sets `ACME_PRIVATE_KEY_MODE=0640` for newly issued keys. Existing 0600 keys need
an explicit group/permission adjustment; changing the variable does not rewrite them. Do not
give key access to all users. Mount the entire output directory, not just `current` or PEM files.

## First start

Inspect the computed `_acme-challenge` names in the Beget panel first. With neither service
running, a staging check can be performed using:

```sh
docker compose --project-directory . --env-file .env -f examples/compose.image.yml -f examples/compose.nginx.yml run --rm beget-acme run --staging --once --accept-dns-replacement
```

Then issue production and start the services:

```sh
docker compose --project-directory . --env-file .env -f examples/compose.image.yml -f examples/compose.nginx.yml run --rm beget-acme run --once --accept-dns-replacement
docker compose --project-directory . --env-file .env -f examples/compose.image.yml -f examples/compose.nginx.yml up -d
```

Alternatively, after inspecting the panel, enable `ACME_ACCEPT_DNS_REPLACEMENT=true` and use
`up -d` for first issuance as well. Nginx waits for ACME's healthcheck to pass; this can take
until the next healthcheck after issuance. Staging certificates do not satisfy this production
example. A later ACME outage does not automatically stop an already running Nginx container.
Do not run a second issuance container concurrently with the continuous service.

## Watcher behavior

`NGINX_RELOAD_INTERVAL_SECONDS` defaults to 3600 (1 hour); accepted values are 1–86400 without leading
zeros. The script captures the `current` link and runs the image's original entrypoint.
On each interval it compares the link target. Unchanged versions produce no logs and no reload.
Changed versions trigger `nginx -t`, then `nginx -s reload`. Failed checks or signal commands
are logged and retried at the next interval, leaving the previous loaded certificate in use.
Files in `cert-*` are immutable: editing a PEM in place without switching `current` is not detected.

The default `NGINX_CERTIFICATE_LINK` is `/etc/nginx/certs/production/current`. For a different
path, change both the script environment and Nginx certificate directives. Missing `current`
at startup causes failure; missing `current` while running is logged and retried.

Stopping the container stops the timer and sends QUIT to Nginx for graceful shutdown. An
unexpected Nginx exit is detected within about one second and exits nonzero. The watcher is
the main container command: its death terminates the container too, so Compose can restart it.
Docker may force termination after `stop_grace_period`
if long-lived connections prevent graceful completion.

“Reload requested” confirms successful signal delivery, not successful application by the
master. Nginx can roll back a failed reload; inspect errors and monitor the actual TLS endpoint.
See [Nginx control documentation](https://nginx.org/en/docs/control.html).

`npm run test:nginx` runs a disposable Docker integration test with self-signed certificates:
unchanged versions, real served-certificate replacement, failed-check/reload retries, watcher
failure and graceful stop. It never uses your `.env`, state, real certificates or Beget API.
