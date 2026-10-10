# Installed SDK identity during dependency upgrades

Owner: [pm-brief-m8hh](../.agents/pm/chores/pm-brief-m8hh.toon). Companion:
[2026-10-10 fleet session](https://github.com/unbraind/pm-cli-companion/blob/main/.agents/pm/tasks/pm-cli-website-session-2026-10-10.toon).

The previous compatibility test compared the development SDK pin with a second
hardcoded version in the test helper. A correct dependency automation update
therefore failed until someone changed an unrelated test constant. Installing
published SDK 2026.10.9 reproduced that failure against the old 2026.10.4 constant.

The helper now resolves the installed SDK's public package metadata and validates
its exact release identity. The manifest must match that independently installed
version. A disposable copy passes unchanged, then fails after only the manifest
pin is changed to 9999.1.1. This prevents the assertion from merely comparing the
manifest with itself. The independently supported runtime floor remains 2026.8.20.

The final dependency is SDK 2026.10.10, published during verification. Its complete
`npm run release:check` passes all 367 tests with zero skips, typechecking, build,
release-workflow validation, production audit with zero advisories, changelog
verification and publication attestation. Packed npm-current and native Bun-current
consumers use 2026.10.10; the npm-minimum consumer uses 2026.8.20. All three exercise
bounded output and the refusal when the requested context cannot fit.

The existing V8 gate measures one runtime source file: lines and functions are
100%, branches are 97.96%, and statements are not independently reported. This
passes the configured gate; it does not meet the requested all-source four 100%
standard. [pm-brief-gtiy](../.agents/pm/issues/pm-brief-gtiy.toon) remains open for
that work. The documentation gate measures 107 declarations across seven files.
Required reviews and privacy certification remain separate gates.
