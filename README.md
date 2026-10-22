# pm-brief

`pm-brief` generates compact, deterministic project briefs for coding agents.
It turns pm items into an execution-oriented summary: what to work on next,
what is blocked, what context is stale, and which pm updates should be made.

Project management is context management. `pm-brief` makes that practical when
an agent needs a low-token handoff instead of a full project dump.

## Install

```bash
pm install npm:pm-brief --project
```

> The `npm:` prefix is required. A bare `pm install pm-brief` resolves only a local
> directory or a bundled alias, never the registry, and a
> `github.com/unbraind/pm-brief` source cannot work either — pm copies a GitHub
> source as-is without building it, and this repository does not commit `dist/`.

## Usage

```bash
pm brief
pm brief prompt --focus pm-1234 --max-tokens 2500
pm brief --max-tokens 4000 --format markdown
pm brief --dependency-order --format slack
pm brief --focus pm-1234 --include-closed --format json
pm brief --include-history --format slack
pm brief --focus type:Decision --format json
pm brief prompt --include-history --history-limit 20
pm brief next --count 5 --dependency-order --explain --confidence
pm brief next --count 5 --format json
pm brief next --count 5 --explain --format text
pm brief stale --days 7
pm brief since 7d
pm brief since 2026-07-20 --format json
pm brief since 2026-07-20T00:00:00Z --until 2026-07-22 --author alice
```

## Commands

- `pm brief` renders a markdown or JSON project brief.
- `pm brief prompt` renders a compact copy-pasteable agent handoff prompt.
- `pm brief next` returns the ranked next items only.
- `pm brief stale` returns stale open or in-progress items.
- `pm brief since <checkpoint>` renders a delta brief of what changed since a checkpoint.
- `pm brief diverge [base]` previews pm item collisions between two branches **before** merging.
- `pm brief duplicates` sweeps the merged tracker for near-duplicate items the create-time advisory cannot see across branches.
- `pm brief alternatives <id> <id> [more ids]` compares recorded proposals, outcomes and evidence with exact citations and no recommendation.

### Ranking and Budget Flags

- `--max-tokens` is an alias for `--token-budget`: a ceiling on the chosen rendered brief, estimated as `ceil(characters / 4)` (not a model tokenizer).
- `--dependency-order` prefers prerequisite items before dependent work in next-work ranking.
- `--focus` highlights specific item ids, or `type:Type` to highlight every item of a type (repeatable or comma-separated).
- `--include-history` adds a Recent Activity section sourced from `pm activity` to briefs and prompts; `--history-limit` controls the entry count (default 10).
- `--format` renders `markdown` (default), `json` for machine-readable briefs, or `slack` for Slack-formatted briefs.
- `pm brief next --explain` adds transparent score and dependency signals for each ranked item.
- `pm brief` emits a `Brief Insights` section when focus ids are missing, closed focus items are excluded, or active filters hide all open work.
- `--explain` on `pm brief next` includes compact ranking evidence such as unblockability, stale age, dependency fanout, release/deadline proximity, and linked docs/files.
- `--confidence` on `pm brief next` includes the confidence score behind each recommendation.

For `pm brief` (default 4000) and `pm brief prompt` (default 2500), the ceiling
includes headings, pretty JSON whitespace, the final newline, merge receipts,
and omission/disclosure lines. Compaction caps ancillary sections, shortens
display fields with `…`, then drops lower-priority entries. Retained items keep
their IDs and the highest-ranked next item remains available. `omissions` in
JSON, or the rendered omission notice, gives per-section entry counts and
`pm list --all` / `pm get <id>` retrieval hints. Counts are section entries, so
an item appearing in both focus and next can be counted twice. Merge compromise
IDs and pending totals remain complete; `pm merge report` retrieves hidden receipts.

If the smallest actionable brief cannot fit, the command fails before writing
an output file. The error states the minimum required budget and a command to
retry. The API throws `CommandError` with `EXIT_CODE.USAGE` (2), matching existing
usage failures; the host CLI controls process error rendering and exit handling.

API callers can choose the rendering before building:

```ts
import { buildBrief, renderBrief } from "pm-brief";
const brief = buildBrief(items, { tokenBudget: 1000, format: "markdown" });
const output = renderBrief(brief, "markdown");
```

`buildBrief` defaults to budgeting pretty JSON. `renderBrief`,
`renderMarkdownBrief`, `renderSlackBrief` and `renderAgentPrompt` enforce the
selected rendering again if callers change format or modify the returned object.
`budget.estimatedTokens` measures the rendering chosen at build time, including
its own digit count. An unchanged ordinary tracker that already fits keeps its
sections and fields; only the estimate disclosure can differ from older versions.
See [budget evidence and recovery](docs/brief-budget.md) for the regression matrix.

## Agent Brief Contents

- workspace and item counts
- top next items with `whyNow` reasons
- evidence-weighted next-work score, confidence, and ranking reasons
- blocker relationships and dependency context
- stale context findings
- recent activity from `pm activity` (when `--include-history` is set)
- decision items that need human or agent follow-up
- brief insights with actionable command hints when filters or focus ids need attention
- safe suggested pm commands, never auto-applied
- deterministic token-budget trimming

## Agent Handoff Prompt

`pm brief prompt` turns the same structured brief into direct next-turn
instructions for coding agents: ranked work, focus context, blockers, risks,
safe pm commands, and working rules. It is designed for handoffs where the next
agent needs executable context rather than a full project dump.

### Delta briefs (`pm brief since`)

`pm brief since <checkpoint>` produces a token-budgeted **delta brief**: a
categorized summary of what changed since a checkpoint, instead of a full
project re-read. It is purpose-built for the multi-agent merge workflow — when
an agent resumes a project after other agents worked in parallel branches and
merged, it should orient on *what changed*, not re-read everything. Project
management is context management, and a delta brief is the smallest context
that captures the difference.

**Checkpoint formats** (lower bound, passed to `pm activity --from`):

- Relative windows treated as "ago": `7d`, `12h`, `30m`, `2w`. A leading `-` is
  optional — `pm brief since 7d` and `pm brief since -7d` are equivalent (`pm activity --from`
  accepts bare windows directly since pm-cli 2026.7.29).
- ISO timestamps / dates: `2026-07-20`, `2026-07-20T00:00:00Z`.

**Filters:**

- `--until <checkpoint>` — upper bound (passed to `pm activity --to`).
- `--author <name>` — only include changes by this author.
- `--limit <n>` — max activity entries to scan (default 1000, clamped 1–5000).

**Budget & shape:**

- `--max-items <n>` (default 40) and `--token-budget` / `--max-tokens` (default
  4000) trim the lowest-ranked changes to fit; `truncated` / `omittedItems` are
  reported in JSON and markdown when trimming occurs.
- `--format markdown` (default), `text`, `json`, or `slack`; `--output <file>`
  writes the result to a file.

**Categories** (each a section, deterministic order, most decision-relevant
first): Created · Closed · Canceled · Reopened · Status changes (incl. *started*,
*newly blocked*, *unblocked* labels) · Reprioritized · Dependencies · Discussion
(notes + comments) · Other. Items are ranked by change kind, then current
priority, then recency, then id for a fully deterministic order.

**Use case — multi-agent merge re-orientation:** after merging parallel
branches that touched the pm tracker, run `pm brief since <last-sync>` to get a
precise list of created / closed / reprioritized / re-blocked items and new
notes, so the resuming agent can update its plan without re-reading the whole
workspace. The brief ends with a `## Refresh` block showing the exact command
that reproduces it.

### Pre-merge collision preview (`pm brief diverge`)

`pm brief since` is the *post*-merge half of the multi-agent workflow. `pm brief
diverge [base]` is the *pre*-merge half: it answers "which pm items did both
branches touch, and will the field-aware merge driver resolve them cleanly?"
before you run `git merge` — rather than after, when `pm merge reconcile` is
repairing the damage.

```bash
pm brief diverge                                  # HEAD vs origin/HEAD (else main, else master)
pm brief diverge main                             # explicit base
pm brief diverge --base main --head feat/other    # neither side has to be checked out
pm brief diverge --base main --format json        # machine-readable for agents
pm brief diverge --base main --include-clean      # also list one-sided items individually
```

It reads each item's append-only history ledger at the merge base, the base tip
and the head tip, diffs the JSON-Patch paths each side added, and classifies
every item:

| Classification | Severity | Meaning |
|---|---|---|
| `duplicate-id` | high | Both branches minted the **same item id** after the merge base. The driver cannot fix this — one side must be re-keyed. |
| `delete-vs-edit` | high | One side deleted the item while the other edited it. |
| `field-collision` | medium | Both sides wrote the **same field**. The driver resolves it via `--prefer`, so review the losing value. |
| `union-safe` | low | Both sides touched the item but **disjoint fields** — the driver merges both and unions the history. |
| `head-only` / `base-only` | — | Only one side touched it; nothing to resolve. |

`/metadata/updated_at` is treated as benign: it changes on every write and never
produces a collision verdict on its own.

The verdict is `clean` (no item touched by both sides), `union-safe` (all
both-sided items have disjoint fields), or `review-required` (any high/medium
finding).

**Merge fence check.** The report also verifies the field-aware driver is
actually installed — the `.gitattributes` entries *and* the `merge.*.driver` git
config. Without both, even `union-safe` items hard-conflict, so a missing fence
is reported as a warning with `pm merge install` as the first recommended step.

**Unrelated histories.** When the refs share no merge base, `unrelatedHistories`
is `true` in the JSON (an explicit boolean, because `JSON.stringify` drops the
`undefined` `ancestorSha`), every changed item is reported one-sided, and the
recommended merge command becomes `git merge --allow-unrelated-histories <base>`
— the bare form git refuses outright.

Each report ends with an ordered `Recommended next steps` block containing only
the commands that apply, including `pm history <id> --verify` per high-severity
item and a `pm brief since <merge-base-date>` for post-merge re-orientation.

### Default governance scan cost

`pm brief` and `pm brief prompt` run the shared SDK governance scanners by
default: duplicate clusters, stale in-progress history, storage integrity, and
credential-shaped item text. The independent asynchronous scans run
concurrently and fail independently, so an advisory scanner cannot suppress the
core brief. Use `--no-governance` for latency-sensitive calls that do not need
these signals.

Measured on a real 481-item tracker with pm CLI 2026.7.26, loading item bodies
and collecting the complete governance summary took **1.48 seconds** with
**137 MB peak RSS**. The report remains bounded to 3/5/5/5 findings before the
normal token-budget compaction tightens it further. Runtime depends on tracker
size and history volume; use the governance-free flag when sub-second context is
more important than the audit signals.

### Post-merge duplicate sweep (`pm brief duplicates`)

`pm brief diverge` closes the *pre*-merge gap. There is still one hole it cannot
reach: two agents who each create a **new** item on their own branch both land
cleanly on `main` — the field-aware merge driver is deliberately conflict-free
for that — and neither create-time duplicate advisory can see the other, because
the other item does not exist in that branch's tracker yet. `main` now holds two
items for one problem and nothing ever flags it.

`pm brief duplicates` is the post-merge sweep that closes that loop. It enumerates
the merged tracker, asks the shared SDK `findSimilarItems` primitive (the same
one `pm create` advisory mode uses, so the two agree exactly) for near-duplicate
matches per candidate, and collapses bidirectional matches into unordered pairs
ranked by score.

```bash
pm brief duplicates                                  # default threshold 0.6, all statuses
pm brief duplicates --threshold 0.5                 # looser match cutoff (0..1 inclusive)
pm brief duplicates --since 2026-07-25               # post-merge mode: only items created at/after this merge
pm brief duplicates --status open,closed --limit 5  # filter candidates, cap pairs reported
pm brief duplicates --format json                    # bare object, no envelope
```

For each pair it emits both ids, titles, statuses, types, the score rounded to
three decimals, the SDK match reason, and an **advisory** remediation command
(never executed by this command):
- when exactly one of the pair is closed, it suggests linking the open item to
  the closed one: `pm update <open-id> --dep id=<closed-id>,kind=related`;
- when both are open (or both closed), it keeps the older item by `created_at` as
  canonical and relates the newer to it.

A clean tracker is a success, not an error — the command exits 0 with an explicit
`No likely duplicate items found` line.

**Choosing a threshold.** This matters more than it looks: the default `0.6` is
deliberately conservative, and real cross-agent paraphrases often score *below*
it. The worked example below scores `0.5` — two agents describing the same flaky
test — so a default-threshold sweep would not report it. `title_token_jaccard`
compares token sets, so paraphrases that agree on the problem but not the wording
score lower than an intuition calibrated on "these are obviously the same bug"
would suggest.

Practical guidance:

- `--threshold 0.4` for a genuine post-merge sweep, where a handful of false
  pairs to eyeball costs far less than a duplicate that survives on `main`.
- `0.6` (default) when you want only high-confidence pairs, e.g. in automation
  that acts without a human reading the output.
- Exact-title collisions surface as `reason: exact_title` and score `1.0`, so any
  threshold catches them; the tuning only affects paraphrases.

For comparison, create-time advisory mode uses `governance.duplicate_detection_threshold`,
which defaults to `0.8` — this sweep is already the more sensitive of the two.

**Cost, and why `--since` is the mode you usually want.** Scoring runs through the
shared SDK primitive per candidate, so an unscoped sweep is inherently
`candidates x tracker-scan`. Measured on a real 1,934-item tracker (pm-cli's own):

| invocation | candidates | elapsed | peak RSS |
| --- | --- | --- | --- |
| `pm brief duplicates` (full sweep) | 1,934 | 36.3s | 268 MB |
| `pm brief duplicates --since <merge-date>` | 42 | 2.7s | 271 MB |

Scans run with bounded concurrency (8 in flight). That was measured rather than
assumed, and the honest result is a **modest** wall-clock gain — 39.1s to 36.3s,
about 7% — because `findSimilarItems` is CPU-bound, and concurrency cannot
parallelize CPU work on a single-threaded event loop. What it does buy is peak
memory: **526 MB down to 268 MB**, because results are collapsed as they arrive
instead of N full result sets accumulating.

The full sweep is a whole-tracker audit — fine to run occasionally, but it is not
what this command is for. **`--since <merge-timestamp>` is the post-merge mode**
and the one that keeps the cost proportional to what the merge actually
introduced. Trackers of a few hundred items complete quickly either way.

The cost is not avoidable from outside the SDK today: `findSimilarItems` is a
per-candidate query with no batch entry point, and the exported
`scoreItemSimilarity` re-tokenizes both titles on every call, so precomputing
tokens and pre-filtering on `jaccardSimilarity` would silently drop `issue_code`
matches (two titles sharing an issue code score ~0.99 while their token overlap
can sit well below any useful threshold). Reimplementing that signal locally would
break the exact agreement with create-time advisory that this command depends on,
so it is deliberately not done. Filed upstream as
[pm-cli#709](https://github.com/unbraind/pm-cli/issues/709).

Example output on a tracker where two agents each filed the same flaky test from
different branches:

```console
$ pm brief duplicates --threshold 0.3
pm brief duplicates — 1 likely duplicate pair(s) (threshold 0.3, scanned 3)

pm-p800|pm-plbh  score 0.5  title_token_jaccard
  pm-p800: flaky auth test fails intermittently (Task, open)
  pm-plbh: Fix flaky auth test (Task, open)
  → pm update pm-p800 --dep id=pm-plbh,kind=related
```

## TypeScript API

```ts
import { buildBrief, renderMarkdownBrief } from "pm-brief";

const brief = buildBrief(items, {
  tokenBudget: 4000,
  focusIds: ["pm-1234"],
  generatedAt: "2026-06-06T00:00:00Z",
});

console.log(renderMarkdownBrief(brief));
```

### Complete-corpus safety

Every brief command starts from the canonical all-status reader:

```console
pm --pm-path <tracker> list --all --json --include-body --strict-read --no-truncate \
  --output-budget unbounded --output-limit unbounded --output-include full
```

pm-brief passes that envelope through the public pm SDK complete-list
certifier, then rejects any missing or contradictory source, omission,
projection, pagination, universal-output, count, or item-identity receipt. It
never follows a partial cursor or falls back to a bare row array. The narrow
checks supplementing SDK 2026.8.21 are tracked upstream in
[pm-cli#1078](https://github.com/unbraind/pm-cli/issues/1078).

## Release Readiness

This package uses TypeScript, `pm-changelog`, and the same daily release shape
as the other public pm packages. `npm run release:check` runs typecheck, build,
tests, docstring coverage, production audit, dry-run packing, installed-package
acceptance, and changelog validation. The packed acceptance matrix loads real
tracker data through npm/npx and Bun/bunx on the current host, plus npm/npx on
the declared minimum host. Changelog and release-note reads let `pm-changelog`
resolve the installed pm CLI entry through Node (portable to Windows) and
explicitly disable both host output bounds. Toolchain development pins come from
`package.json`; tests require exact versions and matching lockfile root entries,
locked resolutions, and installed package metadata. Routine toolchain updates
need only the manifest and lockfile changes. Consumer host requirements remain
minimum floors, separate from the development pins.

## Multi-agent merge safety

This repo tracks its project management in `.agents/pm/` and ships a committed `.gitattributes`
that maps those tracker artifacts to pm-cli's field-aware Git merge drivers, so concurrent-branch
tracker edits merge cleanly instead of hard-conflicting. The driver **definitions** live in
per-clone Git config; `npm install` / `npm ci` wires them automatically via the `prepare` script, `scripts/prepare-merge-driver.ts`: a launcher that delegates to the installed pm-ops installer. Behavioral tests enforce driver registration, omit-dev and missing-CLI skips, and failure propagation without requiring template equality. The installer calls `pm merge install` when the `pm` CLI is on `PATH` and skips with a notice when it is not. A production install of a clone (`npm ci --omit=dev`) has no `pm-ops`, so the launcher skips with one notice, while a stale or broken `pm-ops` fails the install. Registry installs of this package never run `prepare`. Being Node-based, it behaves identically on POSIX shells and Windows `cmd.exe`. To (re)run manually: `npm run merge:install`.

After merging a branch that touched `.agents/pm/`, reconcile any residual history-hash drift with
**`pm merge reconcile`** (pm-cli ≥ 2026.7.22): preview with `pm merge reconcile --dry-run`, apply with
`pm merge reconcile --message "post-merge reconcile"`, then confirm with `pm validate`, which scans the
whole tracker and flags remaining history drift across **every** affected item (`pm merge reconcile`
itself lists each affected stream in its output; `pm history --verify <id>` spot-checks one item). The field-aware driver already unions every author's
content, so `reconcile` only re-greens the hash chain (no data loss) — see the authoritative
[pm-cli merge-safety guide](https://github.com/unbraind/pm-cli/blob/main/docs/MERGE_SAFETY.md). The
older blunt `pm history-repair --all` remains available as a lower-level primitive.

## Universal read output controls

Requires pm CLI/SDK **2026.10.13 or later**. Read commands accept the host's
`--output-include`, `--output-limit`, `--output-budget`, `--output-format`,
`--output-session`, `--output-cursor`, and `--output-row-contract` controls.
Use `pm contracts --command "brief next" --full` to discover the row paths.

Ordinary document and diagram formats retain their existing rendering. When
universal controls are supplied, handlers return structured results so the host
owns projection, omission receipts, budgets, and continuation. `--output` file
writing cannot be combined with these controls. Writers remain undeclared.
An infeasible budget returns `output_budget_exceeded` and CLI exit 2; increase
the budget before using the result. Budget-compacted declared rows include
per-path continuation cursors: repeat the same semantic inputs with
`--output-cursor`, keeping the tracker unchanged, until no cursor remains.
`--output-limit` is an amount ceiling; cursor recovery applies to budget
compaction. Command-local selection limits and document budgets still apply.

### Adoption recipe

1. Pin the development SDK to 2026.10.13 and align the peer and manifest floor.
2. Declare `read_output: { row_keys: [...] }` on readers only; use actual,
   non-overlapping array or object-map paths, or `[]` for a singleton.
3. Return a structured object. Keep raw document rendering on its ordinary
   path, declining the output service when canonical controls are requested.
   Prevent file writes and unbounded diagram stdout on that path.
4. Test the packed extension through its installed host against real temporary
   trackers: projection, budget omission, every-row cursor recovery, and writer
   rejection. Remove only the declarations, rebuild, and prove the tests fail.
5. Run unchanged npm and Bun release gates and document their exact results.

## Acknowledged handoff contracts

`pm brief handoff` records what each receiving agent understood against exact
item content revisions. A packet includes explicit questions, unresolved
assumptions, required evidence and the transitive declared blocker closure.
A changed blocker, source item or evidence item invalidates its old receipts.
Two receivers append independent receipts to the same tracker; identical retries
by the same author add nothing. Claims continue to own work ownership.

```sh
# Set an explicit identity for each sender or receiver.
export PM_AUTHOR=sender
# Replace the focus/evidence item ids in docs/examples/handoff.json.
pm brief handoff preview --input docs/examples/handoff.json --json
pm brief handoff create --input docs/examples/handoff.json --json
# Save the returned id and digest. Then write response.json, as shown below.
PM_AUTHOR=receiver-a pm brief handoff ack <packet-id> --input response.json --json
pm brief handoff show <packet-id> --receiver receiver-a
```

A receiver supplies every obligation id, including evidence that is still missing:

```json
{
  "digest": "<64-character digest from the packet>",
  "questions": { "fixture": "I will use the public tracker fixture." },
  "assumptions": { "review": "Unresolved; I will verify the blocker before proceeding." },
  "evidence": { "report": "The report link is missing; validation remains outstanding." }
}
```

Every collection is explicit; use `[]` in contracts and `{}` in responses when
there are no obligations. Each input collection has at most 32 entries; the
blocker/evidence closure has at most 64 items. Keys use ASCII letters, digits,
dots, underscores or hyphens and start with a letter or digit. Obligation and actor
keys have at most 128 characters; native item identifiers retain their full length. Obligation text and evidence references have at most 2,000 code units.
Native source titles and blocker references retain their full text under the aggregate budget.
Native TOON is the default; `--json` uses the host's
structured JSON output. The default conservative output ceiling is 4,000 tokens,
measured from UTF-8 bytes with twice pretty-JSON size plus framing headroom.
`--token-budget` accepts up to 64,000. Oversized output refuses with a remedy;
it never silently drops questions, assumptions, evidence or receiver receipts.
A receiver filter reduces the selected receipt set without changing storage.
Universal host output controls can intentionally project or paginate read commands;
retain their omission receipts and use normal output for a complete contract.

Evidence requirements select exact native `docs`, `files` or `tests` links by
`item`, `kind` and `ref` (path, or test command). `missingEvidence` remains visible
in the packet and each receipt. Linkage proves a reference was recorded; it does
not prove that a file exists, its contents are correct, or a test passed. Receiver
statements are self-reported understanding, including disagreement or uncertainty.
`valid` means the source revisions still match; `ready` additionally means all
required links are present. Neither field grants approval or claims the work.

Packets are native Decision items tagged `pm-brief-handoff`; their JSON bodies are
immutable protocol artifacts. Receipts are append-only native comments protected
by the host's comment lock and author/text idempotency. Native lock contention
is retried up to three times for reads and idempotent appends; creates are never
automatically retried. Persistent contention refuses with a retry remedy. Do not edit contract bodies
or receipt comments. Create a fresh packet after a revision changes. A receipt
racing a source edit is reassessed on return and every subsequent read. All source
metadata, bodies and linked evidence contribute to content revisions, so even an
unrelated source comment conservatively invalidates old understanding. Reads are
certified full-corpus snapshots, not a transaction spanning arbitrary source writers.

The SDK exports `previewHandoff`, `createHandoff`, `acknowledgeHandoff`,
`inspectHandoff`, their typed contracts, and `HandoffError` (`code`, `remedy`).
Pass `{ pmRoot, author, tokenBudget? }`, optionally with the active native `PmClient`.
CLI expected refusals exit 2 (3 for a stale packet), with a stable `handoff_<code>`
JSON category and a `required` remedy.
Categories cover invalid input, identity, missing packets/items, response coverage,
integrity, budget and tracker reads. Validation and budget checks precede writes.
The commands never change source items or claims; `preview` and `show` are read-only.

This complements [pm-context](https://github.com/unbraind/pm-context)'s
context delivery/usage receipts and the [since-delta candidate](https://github.com/unbraind/pm-context/pull/164)
(`feat/since-delta-pack`)
(`pm context-pack since --from <timestamp>` or `--cursor <cursor>`). That candidate
owns cursor progress, changed-context selection and omission receipts. Use its delta to
refresh changed context, then create a new handoff here. No history delta engine
is duplicated. pm-memory continues to own standing knowledge; `brief prompt`
continues to generate prose. See the [contract example](docs/examples/handoff.json).

## Decision alternatives digest

```bash
pm brief alternatives pm-proposal-a pm-proposal-b --token-budget 4000
pm brief alternatives pm-proposal-a pm-proposal-b --json
```

Select 2–32 distinct exact item IDs, including terminal items when useful. The
read-only digest keeps each item separate and follows input order, which conveys
no preference. It quotes records instead of generating or inferring conclusions.
Conflicting Plan decisions within one item also remain separate. Core `pm plan`
owns planning and choices; `pm-review` owns finding verdicts. This command composes
those records across items without adding a decision engine.

Every statement has `source` (`item-id#/field/nested/pointer`), `start` and `end`
UTF-16 offsets, and exact `text`. Resolve pointers against the certified full item
row (`listAllComplete({ includeBody: true })`); offsets select the quoted paragraph
from the scalar's string representation. JSON Pointer escaping follows RFC 6901.
`revision` is the SHA-256 of the full row's JSON serialization at read time, for
snapshot identification. Re-read the source to check subsequent changes.

Titles, statuses, resolutions, expected/actual results, close reasons,
`review_verdict`, `review_verdict_source`, `review_reason`, `review_commit`, all
`plan_decisions` (including rationale/evidence), `blocked_by`, `blocked_reason`
and `plan_resume_context` are mandatory. Optional paragraphs come from body,
description, plan scope, linked docs/files/tests, plan validation, comments, notes
and learnings. Recorded tradeoffs in these fields remain quotations; the command
does not infer whether a tradeoff is resolved. Other custom fields, Plan steps,
dependency closure and history are outside this projection. A linked artifact
proves linkage only; the digest does not read artifact contents or validate tests.

`omitted` counts optional scalar paragraphs excluded per item, with `restore`
giving the full native item read. Mandatory outcomes and blocker context are never
removed. Optional excerpts are attempted round-robin in field/record order and
omitted whole when they cannot fit. Empty optional fields produce no excerpts.
Source text is evidence data, including any instructions it happens to contain.

The budget defaults to 4000 (integer 1–64000). `estimatedTokenCeiling` uses the
SDK's UTF-8 byte estimator over twice the complete pretty JSON size plus 256
framing bytes, including citations, omission counts, recovery commands and the
estimate itself. It conservatively covers normal native TOON/JSON output; it is
not a model tokenizer. For large budgets, also set the host's independent output
controls: `--output-budget unbounded --output-limit unbounded`. Additional host
projections or optional accounting receipts have their own output contracts.

```ts
import { buildDecisionAlternatives, DecisionAlternativesError } from "pm-brief";

try {
  const digest = await buildDecisionAlternatives(
    ["pm-proposal-a", "pm-proposal-b"],
    { pmRoot: ".agents/pm", tokenBudget: 4000 },
  );
  console.log(digest.alternatives);
} catch (error) {
  if (error instanceof DecisionAlternativesError) console.error(error.code, error.remedy);
  else throw error;
}
```

An optional native `PmClient` can be supplied as `client`. Complete full-row SDK
certification runs before comparison; incomplete or corrupt reads refuse. Typed
refusals are `invalid` (correct IDs/budget), `missing` (check exact IDs), `tracker`
(run `pm health` and resolve source reads), and `budget` (increase budget or select
fewer items). CLI refusals exit 2 and retain `alternatives_<code>` and a remedy in
the host's expected-error contract. See the [worked example](docs/examples/alternatives.md).

## Without git

Briefs, prompts, ranking, history deltas, governance, duplicate checks and all
handoff and decision alternatives commands work in plain initialized trackers without a git executable.
Handoff storage uses the native SDK dispatcher and can reuse a host client.
`brief diverge` needs a git repository and git refs. Handoff receipts have no
branch, commit or repository dependency.
