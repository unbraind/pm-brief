# Follow declared consequences after adoption

Install pm-brief in an initialized tracker. Record a measurement with native pm,
then read the exact observation revision:

```bash
pm update measurement-id --actual-result 'Measured latency fell from 90 ms to 60 ms'
pm brief observation measurement-id --json
```

Review the measurement and copy its returned `revision` into this declaration.
Replace the example ids with existing native ids and the revision placeholder
with the returned 64-character value:

```json
{
  "version": 1,
  "adopted": true,
  "outcomes": [
    {
      "id": "latency",
      "expected": "Lower measured latency after adopting the cache",
      "observations": [
        {"item": "measurement-id", "revision": "COPY_REVISION_HERE", "verdict": "observed"}
      ],
      "actions": []
    },
    {
      "id": "maintenance",
      "expected": "Lower maintenance effort",
      "observations": [],
      "actions": ["maintenance-experiment-id"]
    }
  ]
}
```

Store the object on an existing native Decision using the registered field:

```bash
pm update decision-id --field 'brief_follow_through={"version":1,"adopted":true,"outcomes":[{"id":"maintenance","expected":"Lower maintenance effort","observations":[],"actions":["maintenance-experiment-id"]}]}'
pm brief follow-through decision-id --json
```

This runnable declaration reports `maintenance` as unsupported even if its action
is closed. Add a reviewed measurement judgement to change that state. An explicit
`contradicted` verdict remains visible; current opposing verdicts yield
`conflicted`. Changing a measurement makes its older judgement stale. Read and
review its new revision before updating that judgement. Other outcomes retain
their evidence. Replaying the old declaration cannot renew a stale judgement.

The default budget preserves every outcome summary. `omitted: 2` means expected
text and one linked detail were omitted; `restore` recovers the declaration.
Follow-through and observation revision reads work without git and perform no
native mutations.
