# Fleet CI v2

Required checks remain `test (22)`, `test (26)` and `audit-windows`.
PRs and dispatch use quick depth; superseded PRs cancel. Ubuntu jobs have a
25-minute limit; Windows audit has 3 minutes. Dispatch selects code checks.
The old separate `release-gate (npm/bun)` jobs are folded into Node 26.

| Check | Code PR 22 | Code PR 26 | Docs/tracker-only | Deep 22 + 26 |
| --- | --- | --- | --- | --- |
| npm ci / prepare merge drivers | yes | yes | all required jobs | yes |
| Strict tracker health / merge drivers | — | yes | all required jobs | yes |
| Build / test typecheck | yes | via coverage | build for package contents | npm + Bun |
| Tests | quick | quick via coverage | identity, packaging, metadata; packed host-output on Node 26 | full npm + Bun |
| Typecheck / docstrings | — | yes | — | npm + Bun |
| Coverage, unchanged 100/97.85/100 lines/branches/functions | — | quick | — | full npm + Bun |
| Release workflow contract | via tests | gate | — | npm + Bun |
| Production audit | — | gate | — | npm + Bun |
| Pack dry-run / shipped file list | — | gate | both Ubuntu jobs | npm + Bun |
| Packed npm/Bun/minimum-host/global/npx/bunx acceptance | — | gate | Node 26 | npm + Bun |
| Changelog consistency | — | gate | all required jobs | npm + Bun |
| Publish attestation | via tests | gate | all required jobs | npm + Bun |
| Bun package-graph smoke | — | yes | packed acceptance | yes |
| Windows audit, normal and allow-scripts environment | separate required job | separate required job | health/changelog/identity instead | retained in PR |
| CodeQL | matching paths | separate workflow | filtered | main matching paths and weekly scan |

No standalone lint or additional privacy/secret script exists. The identity
suite checks commit authors and private paths even for docs/tracker changes.
The package ships README, changelog, LICENSE and docs/examples, so the cheap
path still builds, enumerates packed files and runs packed consumer acceptance
once on Node 26. Its Bun project/global and bunx ephemeral scenarios already
prove the install paths; only `bun install --no-save` is needed after the code
gate. The Node 22 code job runs build/tests without coverage, changelog or pack.
Windows keeps its actual npm.cmd/environment contract on code changes; docs
changes retain its required check through install/health/changelog/identity.

Deep runs on main pushes, dispatch and daily at 01:31 UTC, away from release
(03:23 and hourly :41) and weekly CodeQL (Monday 02:23). Distinct `deep (22)`
and `deep (26)` checks each run full npm and Bun release gates, with
`PM_TEST_DEPTH=full`, `PM_TEST_TIME_SCALE=3`, 120-minute limits and cancellation
per ref. Local jobs use the persistent npm cache and installed Bun, whose version
is logged; hosted fallback restores npm cache and installs Bun. Setting
`PM_LOCAL_DEEP=off` selects hosted Ubuntu; otherwise jobs queue for pm-local.
No release-owned workflow or verifier is modified.

Depth defaults to full. Quick keeps deterministic seed prefixes: 50/500
sequences, 25/250 per dependency-model seed and 100/1000 floating-point cases.
Fixed product boundary fixtures remain full size. Replay/round-trip thresholds
use actual generated cases, remain nonzero and retain the full-depth expectation.
Only runner and subprocess deadlines scale; the helper rejects invalid factors
before spawning and rounds up to integer milliseconds. Acceptance commands have
a five-minute harness budget before scaling; coverage has twenty minutes.
No product deadline is changed. No control-character filenames were found.

## Measurements

Owner baseline: 39,929 fleet runner-minutes per 24 hours; typical PR wall time
45–90 minutes including about 28 minutes queueing. Successful main run
[43704677677](https://github.com/unbraind/pm-brief/actions/runs/43704677677)
reported up to 680.327 seconds for the 500-sequence handoff model and
297.938 seconds for the recorded dependency model. Required Ubuntu jobs took
19m52s and 19m07s execution, versus 3h19m02s and 3h43m15s wall time; the Windows
job took 47 seconds execution and 23m12s wall. Full depth is not rerun locally;
quick measurements and PR observations belong in the tracker and PR.

The attestation auditor inspects shebangs in tracked docs and tracker files, so
publish-attestation verification also runs on every cheap path.

Local quick coverage passed 635 tests with zero skips in 1046.96 seconds
(17m27s): all six configured source files reported 100% lines, 98.05% branches
and 100% functions. The 90 touched tests passed in 732.601 seconds (12m13s);
the generated-count diagnostic correction passed its focused model rerun in
43.007 seconds. Hosted full and loaded-local quick times are not directly
comparable. No flaky failure or late-seed coverage gap reproduced.
