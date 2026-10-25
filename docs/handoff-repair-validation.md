# Handoff repair validation

Acceptance fixture: 25 independent focus/dependency pairs form a 50-row packet.
One dependency edit emits one obligation group, preserves 24 acknowledgments,
renews to 25 valid acknowledgments, leaves source rows and the original contract
unchanged, and refuses replay after another source edit. Identical renewal retries
add no native comment.

The SDK-backed seeded state model uses seed `0x5eed2025` and 500 operation
sequences: 499 older-input replays, 452 changed-revision round trips and 48
native no-op sequences. It transports contracts, initial responses and renewals through JSON
with compact/indented and LF/CRLF framing, preserves embedded whitespace, replays
older imported inputs, and mutates native body, description, title, priority,
tags, status, notes, comments, docs, files, tests and relationships. Reference
validity compares complete source state read back through the SDK with the last
acknowledged source state, using structural equality without a second normalizer.
Stored native contract and receipt fields are read back through the SDK and
compared to the input model. Native no-op operations must preserve validity.

Interleaving tests use one shared non-git tracker. Each of the six boundaries
before/after initial read, atomic append and verification read receives a real
competing source edit, identical native peer append or foreign receipt-shaped
comment (18 schedules). Each boundary verifies the renewal lease remains held;
afterward the lease can be acquired by a peer. Edits before the final read refuse
stale; edits after that read become pending on the next read. Concurrent renewers
both report success and persist one receipt. Foreign records remain untouched and
are disclosed with a reason. Additional cases cover partial renewals, evidence-only
roots, changed blocker graphs, malformed native records and append failures.

Behavioral revert proof: restoring whole-packet invalidation in `repairSnapshot`
returns 25 groups instead of one, and the 50-row acceptance test fails. The
implementation is restored before verification and commit.

## Recorded dependency regression and model

Read-only review of PR 179 found that recomputing today's blocker closure could
forget required evidence. The fixed regression acknowledges A blocked by B,
with a required link on B, removes the edge, renews A, then removes B's link.
Repair must return A as invalid with B changed and the missing requirement.
The fixed case runs for docs, files and tests, then verifies edits and deletion of
B. A separate transitive case covers dependencies with no declared evidence.

Acknowledgments now persist per-group `items`, `edges` and `evidenceLinks` from
one certified SDK read; native edges and links include complete-metadata hashes.
Renewal preserves all recorded identities while refreshing their revisions and
adding newly reachable dependencies. The reference model stores actual SDK rows
per acknowledged group. It judges validity by structural equality of every
recorded element plus the current reachable set and newly missing requirements;
it does not use package digests or a handwritten field normalizer.

The graph/evidence model passed 500 independent random sequences using seeds
`0xdecafbad` and `0x1052026`. Operations are acknowledgment, partial renewal,
blocker-edge addition/removal, evidence-link addition/removal, evidence-item edits,
focus-item edits and item deletion. Its generated operation counts (including
no-op attempts against absent targets) were 960 acknowledgments, 887 renewals,
473 blocker additions, 223 blocker removals, 455 evidence additions, 348 evidence
removals, 468 evidence-item edits, 479 focus-item edits and 472 deletions.
Every operation checks repair groups, changed
item ids, missing references and valid/invalid counts. Receipt inventories are
read back through the SDK and checked against the model's exact covered items,
native edges and evidence-link coordinates. All sequences use one plain tracker
outside git; live episode data is bounded to prevent large logs obscuring the model.

Behavioral revert proof: restoring current-focus-only projection inside
`dependencySet` makes the fixed regression fail because renewal drops B from the
SDK-read recorded set. The comparison was restored immediately after the failing
run; the pm item records the command and result.

## Public data measurement

Public `pm-brief` main snapshot `6f93af2`: 95 source items. The source snapshot
lives outside git and is read only; complete SDK state before/after is equal.
A separate disposable copy seeds a native contract/acknowledgment and one source
edit, then measures `inspectHandoffRepair` without further writes. Only that
separate copy receives setup and renewal writes. The source tracker and its
snapshot receive zero writes.

| Measurement | Result |
| --- | ---: |
| Source items | 95 |
| Focus groups / packet revision rows | 3 / 3 |
| Affected groups | 1 |
| Preserved acknowledgments | 2 |
| Valid acknowledgments after renewal | 3 |
| Compact JSON packet / delta bytes | 1,040 / 694 |
| Delta conservative token ceiling | 530 |
| Delta generation time on the shared host (post-fix recheck) | 30 ms |
| Measurement writes | 0 |

Reproduce with `node scripts/validate-handoff-repairs.ts <public-snapshot-root>`.
The script creates and removes its own disposable derived tracker; it never writes
the supplied source. CLI integration tests remove git from PATH and set a git
ceiling above the plain tracker. No hosted or private data is used.

The full release gate runs in CI for npm and Bun at the existing thresholds;
local checks are targeted handoff tests, typecheck, test typecheck and docstring
lint. Timing is a single observation, not a throughput or scale guarantee.
