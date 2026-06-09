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
pm brief --max-tokens 4000 --format markdown
pm brief --dependency-order --format markdown
pm brief --focus pm-1234 --include-closed --format json
pm brief next --count 5 --dependency-order --format json
pm brief stale --days 7
```

## Commands

- `pm brief` renders a markdown or JSON project brief.
- `pm brief next` returns the ranked next items only.
- `pm brief stale` returns stale open or in-progress items.

### Ranking and Budget Flags

- `--max-tokens` is an alias for `--token-budget`.
- `--dependency-order` prefers prerequisite items before dependent work in next-work ranking.

## Agent Brief Contents

- workspace and item counts
- top next items with `whyNow` reasons
- blocker relationships and dependency context
- stale context findings
- decision items that need human or agent follow-up
- safe suggested pm commands, never auto-applied
- deterministic token-budget trimming

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
