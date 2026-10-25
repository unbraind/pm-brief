# Renew only changed handoff obligations

Given a contract with 25 focus items and one independent dependency per focus,
acknowledge its digest with `brief handoff ack`. The packet snapshots 50 source
rows. When dependency `demo-gate-1` changes:

```sh
PM_AUTHOR=receiver-a pm brief handoff repair demo-packet --json
```

The result contains one group (`demo-work-1`), its changed dependency coordinate,
its questions, assumptions and affected evidence requirements. It reports
`validAcknowledgments: 24` and `totalGroups: 25` without repeating those 24 groups.
Read the changed source and evidence before responding. Copy the returned
`digest`, group `id` and `target` into a renewal file:

```json
{
  "digest": "<contract digest from repair>",
  "groups": [{
    "id": "demo-work-1",
    "target": "<group target from repair>",
    "questions": {"scope": "I understand the changed public scope."},
    "assumptions": {},
    "evidence": {"report": "The new report reference is recorded; contents still need review."}
  }]
}
```

```sh
PM_AUTHOR=receiver-a pm brief handoff renew demo-packet --input renewal.json --json
```

With stable sources, this returns `groups: []` and
`validAcknowledgments: 25`. Repeating the same request adds no comment. If any
source in that group changes again, the old target refuses with
`handoff_stale` (exit 3); read repair and answer against the new target. Another
receiver keeps independent acknowledgment state on the same native contract.
Use ordinary TOON output by omitting `--json`; `--token-budget` bounds both forms.
