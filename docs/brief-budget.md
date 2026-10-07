# Rendered brief budgets

`pm brief --max-tokens N` and `pm brief prompt --max-tokens N` enforce
`ceil(output.length / 4) <= N` on the chosen output. This is the existing
character heuristic, using JavaScript string length, rather than measured model
tokens or UTF-8 bytes. JSON includes indentation and the final newline.

`buildBrief(items, { tokenBudget, format })` budgets `json` by default; set
`format` to `markdown`, `prompt` or `slack` to keep all the context that the chosen
rendering can afford. Public renderers recheck budgets on format changes or
caller edits. Rendering does not mutate the caller's object.

## Compaction and recovery

An already-fitting brief retains all its content. The estimate is settled with
its own disclosure digits included. Otherwise, the bounded stages are:

1. Cap ancillary sections at 8, 4 and 2 entries.
2. Shorten display fields to 160, 80, 40 and 20 characters, with an ellipsis.
3. Halve lower-priority sections until they are empty, retaining their leading
   entries. Suggested updates, activity, momentum details, risks, stale context,
   governance details and merge-receipt details precede blockers, decisions,
   focus and ranked next work. Retain at least the highest-ranked next ID, or one
   focus ID when no next work exists.

Identifiers and relationship IDs remain exact. Executable commands remain
verbatim. Merge compromise IDs, pending totals and governance totals survive
compaction. The `omissions` receipt gives cumulative per-section entry counts,
whether fields were shortened, and retrieval commands. These counts are not
unique item counts: a focus entry and a next entry can refer to the same ID.

When the smallest supported actionable representation still exceeds the budget,
`buildBrief` and renderers throw `CommandError` with `EXIT_CODE.USAGE` (2). The
concise message gives the minimum for that representation and a format-specific
retry command. Commands fail before writing `--output`; the host owns process
error rendering and exit handling. Mandatory identities can make the minimum
larger on trackers with many pending merge receipts. Use the indicated budget,
or inspect full context with `pm list --all`, `pm get <id>` and `pm merge report`.

## Issue #135 reproduction

Built from base `3a8b85f0df2586753686edb841288b24f962bd97`, using the issue's
50 synthetic items and fixed timestamps. Before used the original public API's
JSON-based compactor for every rendering. JSON below is the pretty CLI output;
the issue's compact `JSON.stringify` estimate was 1227 at 100/300/1000. After
chooses the rendering explicitly. All estimates include the rendering's newline.

| Format | Budget | Before estimate | After estimate / failure |
| --- | ---: | ---: | --- |
| json | 100 | 1539 | cannot fit (minimum 320) |
| json | 300 | 1539 | cannot fit (minimum 320) |
| json | 1000 | 1539 | 892 |
| json | 4000 | 2277 | 2277 |
| markdown | 100 | 856 | cannot fit (minimum 187) |
| markdown | 300 | 856 | 283 |
| markdown | 1000 | 856 | 685 |
| markdown | 4000 | 1318 | 1318 |
| prompt | 100 | 747 | cannot fit (minimum 264) |
| prompt | 300 | 747 | 288 |
| prompt | 1000 | 747 | 944 |
| prompt | 4000 | 945 | 944 |
| slack | 100 | 843 | cannot fit (minimum 173) |
| slack | 300 | 843 | 294 |
| slack | 1000 | 843 | 672 |
| slack | 4000 | 1301 | 1301 |

For the repository tracker saved before adding this feature item (80 items),
using generatedAt `2026-10-05T00:00:00Z` and pmVersion `2026.10.5`:

| Format | Budget | Before | After | Content |
| --- | ---: | ---: | ---: | --- |
| JSON | 4000 | 2543 | 2543 | unchanged |
| Markdown | 4000 | 929 | 929 | unchanged |
| Prompt | 4000 | 775 | 775 | unchanged |
| Slack | 4000 | 918 | 918 | unchanged |

Content comparison normalizes only the corrected estimate disclosure. No
sections, fields or item references change, and no omission receipt is added.

## Verification

`test/budget.test.ts` exercises the actual API and registered commands with a
scratch tracker: budgets 100/300/1000/4000, long fields, all four formats,
cannot-fit recovery, stdout/files, merge receipts, governance totals and
cumulative omissions. The deterministic generated sweep checks 800 cases
across five tracker sizes, five field lengths, four formats and eight budgets.
It asserts the rendered estimate and the returned estimate stay within budget
whenever generation succeeds; cannot-fit results are retried at their stated
minimum. The package coverage thresholds remain 100% lines, 97.85% branches and
100% functions.

The revert check temporarily restored only the base compactor in `index.ts`,
leaving the new tests and rendering interface intact, then ran:

```sh
node --test --test-name-pattern='issue #135|generated sweep|cannot-fit' test/budget.test.ts
```

The old compactor failed all 18 selected tests (exit 1), including ceiling,
estimate-disclosure and cannot-fit assertions. The fixed implementation was
restored before any final validation. No thresholds or test expectations were
weakened to make that check fail.

Packed acceptance additionally verifies a fitting Markdown rendering and actual
cannot-fit usage exit 2 with recovery on npm/current, Bun/current and npm/minimum
hosts. Every packed scenario selects its disposable tracker explicitly, so an
ancestor tracker or the pm test runner's context cannot redirect fixture writes.
