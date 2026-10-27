# Before attempting a native action

Suppose `project-123` already records a large resolution and its expected
result, depends on unfinished `project-122`, and declares a required report.

```sh
pm --json brief action close project-123 --request '{"input":{"reason":"Delivery reviewed"},"requiredEvidence":[{"kind":"docs","ref":"docs/report.md"}]}'
```

The checklist identifies `actual_result` and the report linkage as missing and
`project-122` as unresolved, all in this call. Existing resolution and expected
result values are represented by `project-123#/resolution` and
`project-123#/expected_result`. The reason reference is
`request#/input/reason`. The preview never closes the item or runs its tests.

Resolve the prerequisites and record actual evidence through native commands,
then request a fresh preview. `ready` means the observed checklist is complete;
the later native command still checks current state and mutation-time policy.

```ts
import { buildActionPrerequisiteBrief, ActionPrerequisiteError } from "pm-brief";

try {
  const preview = await buildActionPrerequisiteBrief({
    command: "close",
    item: "project-123",
    input: { reason: "Delivery reviewed" },
    requiredEvidence: [{ kind: "docs", ref: "docs/report.md" }],
    tokenBudget: 4000,
  }, { pmRoot: ".agents/pm", client: hostClient });
  // Retain preview.item.revision as the observed revision, not an execution key.
  console.log(preview.ready, preview.checklist, preview.refusals);
} catch (error) {
  if (error instanceof ActionPrerequisiteError) console.error(error.code, error.remedy);
  else throw error;
}
```

A request for `delete` returns an `unsupported` command refusal with native
contract-discovery guidance. A matching approval policy adds an explicit
approval-history capability refusal. Neither can become `ready: true`.
JSON and TOON contain the same obligations; an insufficient ceiling refuses
the entire preview rather than dropping missing fields.
