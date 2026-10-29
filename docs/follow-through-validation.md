# Decision follow-through validation

The feature reads the native optional `brief_follow_through` Decision field and
verified SDK history. It owns no importer, sync path, journal, lease, claim,
outbox or remote mutation. Native create/update behavior stays with pm. There
are no count-derived ratios or floating-point decisions.

## Overlap recheck

On package main `1b3603fb35fd4ccfba46317b6886796459cfef65`, alternatives digests
extract proposals and Plan rationale before adoption. pm-review owns review
judgments; pm-evidence owns source citation checking. Core exposes native
Decisions, certified complete reads, history verification, status registry roles
and host JSON/TOON rendering. Follow-through composes explicitly declared
consequences afterward. It neither adopts a choice from status nor interprets
closed work as successful consequences.

## Focused validation

`node --test --test-concurrency=1 test/follow-through.test.ts` exercises real
SDK-created non-git trackers, explicit scope under ambient focus, independent
outcomes, conflicting judgments, changed/empty/missing/unreadable observations,
bad-row isolation, ABA and historical replay, custom status roles, exact budget
boundaries, strict input/output numeric domains, accessors/proxies/sparse arrays,
and native JSON/TOON without a git executable. The renderer ownership inventory
also includes both new commands.

The seeded model (`0x5eed1029`) passed 500 operation sequences with 136 native
operations and 22 historical declaration replays, including native
field and relationship changes, eight generated custom statuses, ambient focus,
whitespace/CRLF variants and old declaration replays. Expected state comes from
a simple set model over state read back through the SDK. Native normalization
is never reimplemented. Every declaration producer is parsed and JSON-round-tripped;
checkpoint mutations persist declarations natively, with every sequence checked
against state read back through the SDK. Brief production leaves the
SDK-read target unchanged. Interleavings inject real competing native writes at
both corpus-read boundaries and after the final snapshot; retry reports the
peer's resulting state.

A behavioral revert in a disposable non-git copy disabled only the revision
freshness comparison. The stale-observation regression failed (exit 1), retaining
`observed` where `unsupported` was required. The fixed worktree was untouched;
the fixed regression subsequently passed through `pm test --run --progress`.
All three linked test commands passed (six test cases), including the updated
native command inventory. Focused module coverage was 100.00% lines,
98.45% branches and 100.00% functions, with nine focused tests passing. The
separate 500-sequence model also passed. Input/output fuzzing additionally checks
1,000 seeded IEEE-754 bit patterns and explicit extreme values.

The 20-outcome fixture retains every outcome identity/state with 50 explicit
omitted details: **1,905 pretty JSON bytes**, a conservative ceiling of **1,017
estimated tokens**, below **1,500**. The same 20-outcome fixture through the native
CLI emitted **1,906 JSON bytes / 477 estimated tokens** and **675 TOON bytes / 169
estimated tokens**, including the trailing newline. Invalid budgets refuse before acquiring a tracker. Optional
detail groups never erase mandatory summaries or invalid-row remedies.

## Public tracker reads

Trackers were archived from public `origin/main` into plain scratch directories
without git metadata. Native derived read caches were warmed before the measured
window. Every regular tracker file, including runtime files, was hashed before
and after validation. No declaration was invented or written to real data.

| Public source | Items | Decisions | Explicit declarations | Observation revisions | Largest response | Files checked / changed |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| pm-brief `1b3603fb35fd4ccfba46317b6886796459cfef65` | 99 | 0 | 0 | 3 | 102 bytes / 26 estimated tokens | 212 / 0 |
| pm-vcs `1671ccb4d2bb8672c83627f015bb5ef60a8d1898` | 164 | 4 | 0 | 3 | 164 bytes / 41 estimated tokens | 341 / 0 |

All four real Decisions returned typed `not_adopted` refusals with remedies.
Positive adopted-outcome behavior is proven with the synthetic native fixtures;
the existing public trackers have no declarations for this new feature. These
measurements attest read-only behavior and safe refusals, not successful real
outcomes. Final measured validation windows were 3,535 ms and 4,117 ms on the shared
host; they are observations, not performance guarantees.

Reproduce with `node scripts/validate-follow-through.ts <tracker-root>` against
an isolated public copy. The script emits only aggregate counts and checks that
all tracker files remain unchanged.

## Release evidence

Local checks are limited to focused tests, TypeScript, docstrings and diff
validation. CI runs the unchanged full npm and Bun release gates. Packed
acceptance exercises follow-through under project-local npm/Bun, the minimum
supported host, npm global, Bun global, npx and bunx, including revision expiry
and zero Decision mutations. The PR records final gate URLs and pass counts.
