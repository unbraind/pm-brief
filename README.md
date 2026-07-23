# pm-brief

`pm-brief` generates compact, deterministic project briefs for coding agents.
It turns pm items into an execution-oriented summary: what to work on next,
what is blocked, what context is stale, and which pm updates should be made.

Project management is context management. `pm-brief` makes that practical when
an agent needs a low-token handoff instead of a full project dump.

## Install

```bash
pm install github.com/unbraind/pm-brief --project
```

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

- Relative windows: `7d`, `12h`, `30m`.
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
