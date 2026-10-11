# Installed toolchain identity during dependency upgrades

Owner: [pm-brief-m8hh](../.agents/pm/chores/pm-brief-m8hh.toon). Companion:
[2026-10-10 fleet session](https://github.com/unbraind/pm-cli-companion/blob/main/.agents/pm/tasks/pm-cli-website-session-2026-10-10.toon).

The previous compatibility test compared the development SDK pin with a second
hardcoded version in the test helper. A correct dependency automation update
therefore failed until someone changed an unrelated test constant. Installing
published SDK 2026.10.9 reproduced that failure against the old 2026.10.4 constant.

The helper resolves public installed package metadata independently of the
manifest. All three toolchain development dependencies must be exact pins, agree
with the lockfile root specifications and resolved versions, and match installed
metadata. A coherent automated manifest/lock update passes without a second
approved-version constant. Disposable metadata copies exercise later coherent
updates and reject ranges, stale root or resolution entries, missing resolutions,
and installed skew for each dependency. No SDK code is mocked.

The independently supported runtime floor stays a minimum. Its peer declaration
and extension declaration must agree; the development CLI may be newer. Packed
acceptance still runs a real tracker on that declared minimum host.

Prepare delegates to the installed pm-ops entry. Tests enforce registration and
skip/failure behavior in fresh Git checkouts rather than compare template bytes.
All existing broken-package, inconclusive-lookup, exit-status, and signal safety
checks remain, with an additional installed-package/missing-CLI scenario.

The focused contract suite passes 34 tests without skips. Reverting only the
toolchain checker to its previous CLI-only pin/installed validation produces 13
assertion failures among the 16 new metadata tests; restoring it passes all 16.
The regression tests remain unchanged during that control and run TypeScript
directly, so compiled output cannot mask the reverted behavior.

Both complete `npm run release:check` and `bun run release:check` passed on the
original manifests and the actual automated update manifests: 384 tests per
gate, no failures or skips, and all three real-tracker packed consumers. Both
npm gates used a disposable HOME with global and system Git configuration
disabled. The update pair used CLI and pm-ops 2026.10.6 with pm-changelog
2026.10.5; the original manifest pair was restored afterward. Thresholds and
the minimum host were unchanged. Bun receipts establish script-runner and
bunx-launcher behavior, without claiming native Bun SDK execution.

The earlier installed-SDK repair verified SDK 2026.10.10. Its complete
`npm run release:check` passed all 367 tests with zero skips, typechecking, build,
release-workflow validation, production audit with zero advisories, changelog
verification and publication attestation. Packed npm-current and Bun-current
consumers use 2026.10.10; the npm-minimum consumer uses 2026.8.20. All three exercised
bounded output and the refusal when the requested context cannot fit.

The existing V8 gate measures one runtime source file: lines and functions are
100%, branches are 97.96%, and statements are not independently reported. This
passes the configured gate; it does not meet the requested all-source four 100%
standard. [pm-brief-gtiy](../.agents/pm/issues/pm-brief-gtiy.toon) remains open for
that work. The documentation gate measures 107 declarations across seven files.
Required reviews and privacy certification remain separate gates.
