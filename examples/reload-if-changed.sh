#!/bin/sh
# Run on the TLS server host, independently of DNS cleanup and issuance exit status.
# Usage: reload-if-changed.sh CERTIFICATE MARKER_DIRECTORY COMMAND [ARGUMENT...]
set -eu
certificate=$1
marker_dir=$2
shift 2
[ "$#" -gt 0 ] || exit 2
mkdir -p "$marker_dir"
chmod 700 "$marker_dir"
# Serialize invocations; a crashed invocation needs manual stale-lock inspection.
mkdir "$marker_dir/lock" 2>/dev/null || exit 1
trap 'rmdir "$marker_dir/lock"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
digest_line=$(sha256sum "$certificate")
fingerprint=$(printf '%s\n' "$digest_line" | cut -d ' ' -f 1)
previous=$(cat "$marker_dir/applied" 2>/dev/null || true)
[ "$fingerprint" != "$previous" ] || exit 0
# Execute arguments directly, without eval. Update the marker only after success.
"$@"
printf '%s\n' "$fingerprint" > "$marker_dir/applied.tmp"
mv "$marker_dir/applied.tmp" "$marker_dir/applied"
