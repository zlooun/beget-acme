# Changelog

## 0.2.0-beta.3

- Retry stale recursive DNS answers until the propagation deadline while retaining strict authoritative checks.
- Repeat DNS preflight immediately before each name's mutation and explain ambiguous recovery with actionable diagnostics.
- Allow read-only diagnostics with invalid setup approval without granting write access.
- Restore broken certificate pointers from validated local versions; preserve damaged markers and refuse replacement on access errors.
- Preserve a Windows pointer backup during replacement and roll it back on failed rename.
- Bound Beget response bodies and validate existing account-key files, permissions and RSA strength.
- Reject overlong computed challenge names, check NAPTR/PTR during preflight, and expose structured JSON error codes/hints.
- Expand recovery, boundary and process-death tests; document DNS scope, shared certificate access and recovery limits.

## 0.2.0-beta.2

- Fix the Linux certificate-permission test to inspect application-created files before replacing them.
- Include the license and repository metadata in the container image.
- Clarify container user overrides, bind-mount permissions and file-secret access.
- Group routine dependency updates separately from major npm upgrades.

## 0.2.0-beta.1

Initial public beta.

- Issue and renew certificates for explicit domain, subdomain and wildcard SAN lists across Beget-managed zones.
- Discover managed zones or use an explicit list; group DNS-01 challenges by DNS name.
- Start with one command and explicit DNS replacement consent; optional interactive setup saves scope approval.
- Use one renewal loop with configurable success/error intervals, persisted CA backoff and automatic recovery.
- Default renewal to one third of certificate lifetime; support an explicit remaining-days threshold.
- Validate DNS before contacting the CA; confirm cleanup on authoritative servers with a stability interval.
- Preserve DNS journals, reject foreign records and recover interrupted certificate publication.
- Use OS-backed operation locks, atomic state writes and versioned certificate/key pairs.
- Provide separate staging/production certificates, account management, diagnostics and one-shot operation.
- Support non-root Docker deployments, custom UID/GID, file-based secrets and local Node.js execution.
- Include Compose, systemd, Nginx and external reload examples, with English and Russian documentation.
- Use strict TypeScript, ESLint, Prettier and isolated protocol, filesystem and recovery tests.
