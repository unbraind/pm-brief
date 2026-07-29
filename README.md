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

### Ranking and Budget Flags

- `--max-tokens` is an alias for `--token-budget`.
- `--dependency-order` prefers prerequisite items before dependent work in next-work ranking.
- `--focus` highlights specific item ids, or `type:Type` to highlight every item of a type (repeatable or comma-separated).
- `--include-history` adds a Recent Activity section sourced from `pm activity` to briefs and prompts; `--history-limit` controls the entry count (default 10).
- `--format` renders `markdown` (default), `json` for machine-readable briefs, or `slack` for Slack-formatted briefs.
- `pm brief next --explain` adds transparent score and dependency signals for each ranked item.
- `pm brief` emits a `Brief Insights` section when focus ids are missing, closed focus items are excluded, or active filters hide all open work.
- `--explain` on `pm brief next` includes compact ranking evidence such as unblockability, stale age, dependency fanout, release/deadline proximity, and linked docs/files.
- `--confidence` on `pm brief next` includes the confidence score behind each recommendation.

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

## Release Readiness

This package uses TypeScript, `pm-changelog`, and the same daily release shape
as the other public pm packages. `npm run release:check` runs typecheck, build,
tests, production audit, dry-run packing, and changelog validation.

## Multi-agent merge safety

This repo tracks its project management in `.agents/pm/` and ships a committed `.gitattributes`
that maps those tracker artifacts to pm-cli's field-aware Git merge drivers, so concurrent-branch
tracker edits merge cleanly instead of hard-conflicting. The driver **definitions** live in
per-clone Git config; `npm install` / `npm ci` wires them automatically via the `prepare` script (a portable Node guard, `scripts/prepare-merge-driver.mjs`: it runs
`pm merge install` only when the `pm` CLI is on `PATH`, and no-ops cleanly otherwise so
production / `--omit=dev` installs are not broken; being Node-based it behaves identically
on POSIX shells and Windows `cmd.exe`). To (re)run manually: `npm run merge:install`.

After merging a branch that touched `.agents/pm/`, reconcile any residual history-hash drift with
**`pm merge reconcile`** (pm-cli ≥ 2026.7.22): preview with `pm merge reconcile --dry-run`, apply with
`pm merge reconcile --message "post-merge reconcile"`, then confirm with `pm validate`, which scans the
whole tracker and flags remaining history drift across **every** affected item (`pm merge reconcile`
itself lists each affected stream in its output; `pm history --verify <id>` spot-checks one item). The field-aware driver already unions every author's
content, so `reconcile` only re-greens the hash chain (no data loss) — see the authoritative
[pm-cli merge-safety guide](https://github.com/unbraind/pm-cli/blob/main/docs/MERGE_SAFETY.md). The
older blunt `pm history-repair --all` remains available as a lower-level primitive.
