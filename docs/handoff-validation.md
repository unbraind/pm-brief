# Public tracker validation

The read-only input was the public pm-brief `origin/main` tracker at `46295a6`.
The validated runtime source was `c55c13b`. A disposable copy lived outside git,
with git absent from the process PATH. All 179 copied files were made read-only;
the complete relative-path/SHA-256 inventory matched before and after execution.
The source checkout and source tracker were untouched.

Reproduce with a disposable public snapshot and:

```sh
node scripts/validate-handoffs.ts <snapshot-storage-root>
```

Measured on 2026-10-21:

| Measurement | Result |
| --- | ---: |
| Certified full tracker items | 86 |
| Preview packets | 5 |
| Item revision rows | 5 |
| Deliberately missing evidence requirements retained | 5 of 5 |
| Compact JSON bytes per packet | 798–876 |
| Compact JSON bytes total | 4,159 |
| Conservative token ceiling per packet | 611–650 |
| Generation latency median / maximum | 658 / 1,290 ms |
| Original copied files unchanged | 179 of 179 |

These are read-only preview measurements under shared-host load, not a capacity
or latency guarantee. Receipts require writes and were validated separately on
real SDK-initialized synthetic trackers. The regression suite covers independent
receiver processes writing to the same non-git tracker with no git executable,
blocker revision changes, required-link gaps, idempotent retries, malformed
artifacts, bounded inputs and refusal-before-write behavior.

No hosted data or private tracker content was used. No source item, claim or
standing knowledge was changed. Evidence presence means native linkage, not
artifact-content validation or proof of test success.
