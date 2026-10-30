# Contributing

Use Node.js 24.22.1 LTS and install the locked dependencies with `npm ci --ignore-scripts`.
Run `npm run check` before submitting changes. `npm run package:check` verifies the built
artifact and installed CLI; it may access the npm registry. `npm run coverage` reports test
coverage. Runtime code is strict TypeScript; comments and error messages are English.

Use `npm run lint:fix` and `npm run format` for formatting. Keep type-aware ESLint rules
active. The test runner is Node's built-in `node:test`; no additional runner is required.
Add behavior-focused tests for protocol, recovery, configuration and filesystem changes.
Tests must use isolated temporary directories and mocks, never real DNS credentials.

Do not commit `.env`, private keys, runtime state/output, installed dependencies or compiled
build directories. Keep the lockfile in sync. Review dependency licenses and production
audit results when updating packages. Preserve supported account keys and recovery journals.
A journal migration must fail closed on unknown or malformed data.

Describe the user-visible problem, the final behavior and validation evidence in pull requests.
Do not claim live staging or production checks based on mocked tests. Changes that write DNS
must retain explicit operator authorization and independent provider allowlists.

Keep direct startup and optional interactive setup documented together in RU/EN. Cover
inline consent, scope changes, pending recovery, persisted retry deadlines and per-host TLS
preferences with isolated tests. DNS polling logs must distinguish reads from mutations.
