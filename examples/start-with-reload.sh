#!/bin/sh
# Container entrypoint for nginx-unprivileged; run through /bin/sh.
set -u

interval=${NGINX_RELOAD_INTERVAL_SECONDS:-3600}
certificate_link=${NGINX_CERTIFICATE_LINK:-/etc/nginx/certs/production/current}

case "$interval" in
  ''|*[!0-9]*|0*)
    echo "NGINX_RELOAD_INTERVAL_SECONDS must be an integer from 1 to 86400 without leading zeros." >&2
    exit 2
    ;;
esac
if [ "${#interval}" -gt 5 ] || [ "$interval" -gt 86400 ]; then
  echo "NGINX_RELOAD_INTERVAL_SECONDS must be at most 86400." >&2
  exit 2
fi

# Capture before startup: a concurrent pointer change will trigger a later reload.
loaded_version=$(readlink "$certificate_link") || {
  echo "Cannot resolve the current certificate version; issue a certificate first." >&2
  exit 1
}

nginx_pid=""
sleep_pid=""

stop_children() {
  trap '' TERM INT QUIT
  if [ -n "$sleep_pid" ]; then
    kill "$sleep_pid" 2>/dev/null || :
    wait "$sleep_pid" 2>/dev/null || :
  fi
  if [ -n "$nginx_pid" ]; then
    kill -QUIT "$nginx_pid" 2>/dev/null || :
    wait "$nginx_pid" 2>/dev/null || :
  fi
}

shutdown() {
  stop_children
  exit 0
}
trap shutdown TERM INT QUIT

# Preserve the standard image initialization and its foreground Nginx master.
/docker-entrypoint.sh nginx -g 'daemon off;' &
nginx_pid=$!

echo "Nginx certificate watcher started; interval: ${interval}s; version: $loaded_version."
elapsed=0

# The watcher is the container's main command, not an unsupervised background process.
# Check master liveness each second; inspect certificates only at the configured interval.
while kill -0 "$nginx_pid" 2>/dev/null; do
    sleep 1 &
    sleep_pid=$!
    if ! wait "$sleep_pid"; then
      break
    fi
    sleep_pid=""
    if ! kill -0 "$nginx_pid" 2>/dev/null; then
      break
    fi
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -lt "$interval" ]; then
      continue
    fi
    elapsed=0

    if ! current_version=$(readlink "$certificate_link"); then
      echo "Cannot resolve the certificate version; retrying at the next interval." >&2
      continue
    fi
    if [ "$current_version" = "$loaded_version" ]; then
      continue
    fi

    echo "Certificate version changed: $loaded_version -> $current_version."
    if ! nginx -t; then
      echo "Nginx configuration check failed; keeping the previous version and retrying later." >&2
      continue
    fi
    if ! nginx -s reload; then
      echo "Nginx reload command failed; retrying at the next interval." >&2
      continue
    fi

    # This records an accepted signal, not confirmation from the TLS endpoint.
    loaded_version=$current_version
    echo "Nginx reload requested for certificate version: $loaded_version."
done
echo "Nginx or the watcher timer exited; stopping the container." >&2
stop_children
exit 1
