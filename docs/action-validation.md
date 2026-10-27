# Action prerequisite validation

Work item: [pm-brief-action-prerequisites](../.agents/pm/features/pm-brief-action-prerequisites.toon).

Overlap was rechecked against the pinned public SDK declarations and native
command discovery, sibling pm-lint rules, pm-evidence selectors, tracker items
and upstream issue search. Core owns command availability, readiness and
workflow semantics. This package combines those facts for an explicitly
selected action. It does not choose work or create a competing quality validator.

The new surface is read-only. It adds no import/export/sync or journaled writer
path; import round-trip/idempotency and writer-lease interleavings are therefore
outside this change. Two real native SDK read boundaries are instrumented with
competing native writes; each rejects a stale preview with `changed`, and a
fresh request reports the current SDK revision. No SDK result is mocked.

Action-specific regressions prevent work-dispatch classifications from blocking
explicit native actions. Selected starts use native claim/update admission,
without dispatch-only human/gate/container or nonterminal-status vetoes.
Evidenced Decision, Milestone, blocked and draft items can also produce a ready
close preview, while unfinished direct children remain visible for close through
the SDK child rollup. Existing dispatch classification assertions remain and are
paired with successful native execution checks.

Another native reproduction verifies the policy boundary: close clears an
assignment, so core refuses a field-writer or required-assignee policy that a
partial proposed record would incorrectly satisfy. Such workspace field/writer
policies now carry explicit unsupported-capability refusals and a native semantic
preview remedy. Start-task also exposes matching claim-stage policy constraints,
rather than silently evaluating only its update stage. The regression checks
real native refusals and fails against the earlier projection. Native start
status and actor normalization use the SDK resolvers.
Ownership checks compare the SDK-resolved intended principal only when a current
nonblank assignee establishes live ownership. Residual principals after native
close/reopen do not deny either action. Legacy assignee-only ownership still
denies another actor; missing actors remain inputs and matching actors pass.

The round-1 re-review class audit covers all runtime admission and ownership
sites, SDK/CLI paths, both renderings and the seven packed install consumers.
Its native regressions cover 48 SDK-recognized update-option keys and required,
disabled, hidden, contradictory and create-only policy states. Persisted values
do not satisfy invocation-option requirements. SDK-resolved policies are checked
before any claim; arbitrary required flags outside this request surface produce
missing entries and explicit unsupported-capability remedies. Native generated
status and declared author options remain references. Separate properties cover
six close/reopen ownership cycles across all three ownership modes and two new
actors, legacy live assignments, and 15 type/status combinations with unfinished
children. Native non-git JSON/TOON and packed consumers check the same classes;
packed fixtures include records written by the pinned previously released SDK.

The focused suite includes 500 seeded operation sequences (seed `0x5eed2026`)
on one non-git tracker: random prospective field inputs, old-input replays,
blank/CRLF/Unicode values, native relationship and lifecycle changes, 12 custom
status definitions, random ambient focus, and JSON round trips. Expected
missing-field decisions come from the native policy evaluator and state is read
back through the SDK, with no handwritten normalization oracle. Every sequence
checks authoritative file fingerprints and emitted numeric domains. Separate
cases reject sparse arrays, nonfinite and extreme budgets and malformed records.
Adversarial array prototypes, custom iterators, accessors and revoked proxies
also refuse without executing caller callbacks. That boundary regression fails
against the earlier key-count-only density check and passes with own indexed
data descriptors and detached plain records.

The behavior control replaces only `buildActionPrerequisiteBrief` with a no-op
preview while leaving tests and registration unchanged. The combined missing
fields/prerequisites test fails (`ready` incorrectly becomes true, exit 1).
Restoring the function passes that same test (exit 0).

Public-data measurement uses the committed public pm-brief tracker at main
revision `04b258644a746d289455d1287dd84b5bafe6aa1a`, archived into a disposable
directory outside git. All copy files/directories are made physically read-only
before measurement; no git executable is needed by the preview. The source
and copy are never used for any native mutation.

| Measurement | Result |
| --- | ---: |
| SDK-certified public items / close previews | 98 / 98 |
| Missing close inputs identified | 115 |
| Unresolved prerequisite references present in this corpus | 0 |
| Satisfied field/prerequisite references | 277 |
| Unsupported capability refusals present in this corpus | 0 |
| Largest formatted JSON, including newline | 1486 bytes |
| Largest conservative TOON/JSON token ceiling | 808 |
| Elapsed on the shared host | 166174 ms |
| Changed tracker files/bytes | 0 / 0 |

The exact copy fingerprint before and after is
`835e5ee38de52a797bd5cc804b9a3767660add1446ef2ef90d4cfbc021fff891`.
These are measured public-data facts, not evidence that this particular corpus
contains every failure case. Synthetic native trackers establish reverse,
missing and external blockers, custom blocked/done/canceled roles, ownership,
active containers, human decisions, outcome gates and unsupported approvals.

On an ordinary writable cold tracker the native SDK may initialize rebuildable
runtime metadata caches. Tests separately prove no authoritative mutation on
cold reads, byte-identical warm repeated reads, and successful execution on
the physically read-only public copy with zero byte changes.

Local checks are targeted tests, TypeScript checks and the repository docstring
lint gate. Full npm and Bun release gates, unchanged coverage thresholds and the
seven packed installation scenarios run in CI. Their exact-head run and counts
are recorded on the PR linked from the work item after CI completes.

The project-local npm/Bun cases use the unchanged development pin; the minimum
host case retains the declared peer floor. Both disposable global installs
resolve and record the current stable public CLI version, so they also test the
current global host without changing this repository's dependency pins.
Separate npx and bunx cases acquire the current host from their runner caches
without installing a project-local host, rather than merely wrapping a local bin.
