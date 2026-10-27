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
then request a fresh preview. `ready` means the observed mandatory checklist is complete;
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
approval-history capability refusal when it can refuse the action. Matching
workspace field/writer policies and start-task claim-stage policies also refuse
certification when effectively enforced: native actions
can generate or clear metadata beyond the supplied scalar inputs. None of these
capability refusals can become `ready: true`.
JSON and TOON contain the same obligations; an insufficient ceiling refuses
the entire preview rather than dropping missing fields.

An `effect: "advise"` author policy remains visible with `blocking: false`, even
when workspace enforcement is enabled. A disallowed type transition under
`workflow_enforcement: "warn"` likewise carries a warning without denying the
explicit start. Unknown actors and uncertified advisory approvals do not create
mandatory inputs. In contrast, an effective refusal or missing explicitly
requested report still makes `ready: false`. Read `ready` and each entry's
`blocking` flag; an advisory `missing` state alone does not prohibit an action.

For an explicit `start-task`, human/gate dispatch roles and unfinished children
do not substitute for native claim/update admission. A type policy requiring
`update --description` produces a missing `option:description`, even when the
item already contains a description. The request does not accept arbitrary
start mutation flags, so it also returns `start-option:description` with a native
preview remedy. This catches the requirement before native start would claim
the item and then fail its update. `actor` supplies an author option; native
start supplies status automatically. Residual claim-principal metadata without
an assignee does not establish live ownership after close/reopen.
