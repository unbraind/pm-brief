# Decision alternatives validation

Source: public `unbraind/pm-brief` main at
`fefa1c6d903ce46459f261e3b3b63fb64f458aa3`, archived tracker only.
The archive was extracted into a non-git scratch directory. Source files were
read-only, and the validating process had an empty executable search path and
`GIT_CEILING_DIRECTORIES` set to the scratch directory's parent.

```bash
node scripts/validate-alternatives.ts <read-only-tracker-copy> pm-brief-nd0k pm-brief-bjll
```

| Measurement | Result |
| --- | ---: |
| Certified full tracker rows | 88 |
| Selected alternatives | 2 |
| Exact source citations verified | 25 / 25 |
| Optional paragraphs omitted and disclosed | 23 |
| Pretty JSON bytes, including final newline | 7,843 |
| Native estimated JSON tokens | 1,961 |
| Conservative JSON/TOON token ceiling | 3,986 / 4,000 |
| Builder elapsed time on the shared host | 4,115 ms |
| Entire copied tracker changed | No |

Before/after copy SHA-256:
`8300fae71b3b524d001535022a85eb9e812ee4b088a0fb677ccf9d13ae174634`.
Every emitted statement was checked against its original scalar and range.
These historical related records exercise extraction and sizing on public data;
they do not establish that the package can infer which proposals compete.

Targeted regression fixtures separately cover conflicting decisions in one Plan,
independent review verdicts and reasoning, unresolved blocker context, exact
Unicode/CRLF citation ranges, structured values, omission accounting, typed
refusals and native JSON/TOON CLI operation without git. Packed acceptance checks
the command through npm/current, Bun/current and npm/minimum host installations.
Implementation commit `d150db42d71aba10c3da374e722e788051482af0` passed
[CI run 39842819350](https://github.com/unbraind/pm-brief/actions/runs/39842819350):

| Gate | Tests | Packed install scenarios | Source coverage: lines / branches / functions |
| --- | ---: | ---: | --- |
| `npm run release:check` | 413 / 413 | 3 / 3 | 100 / 98.23 / 100 |
| `bun run release:check` | 413 / 413 | 3 / 3 | 100 / 98.18 / 100 |
| Node 22 CI | 413 / 413 | 3 / 3 | 100 / 98.23 / 100 |
| Node 26 CI | 413 / 413 | 3 / 3 | 100 / 98.18 / 100 |

Every suite had zero failures, skips, cancellations and todos. All three source
modules were measured at unchanged thresholds. Windows audit and fresh-checkout
tracker health passed. Packed scenarios used the unchanged development pin
2026.10.17 under npm/Bun and minimum host 2026.10.13 under npm.

Local linked checks passed: feature/renderer regressions 7/7, integration
contracts 3/3, source/test typechecks and docstring lint (155 declarations across
11 files). Disabling only the SDK builder's comparison behavior made the selected
alternative assertion fail (0/1); the exact implementation was restored before
the passing runs. The PR also records final-head CI after these evidence updates.
