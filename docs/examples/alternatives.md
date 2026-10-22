# Comparing cache proposals

Create two native records in a plain initialized scratch tracker:

```bash
pm create --type Decision --title 'Keep the cache' --body 'Lower latency. Unresolved: eviction complexity.'
pm create --type Decision --title 'Remove the cache' --body 'Less maintenance. Unresolved: cold-start latency.'
# Substitute the exact IDs returned by those commands.
pm brief alternatives <keep-id> <remove-id> --json --token-budget 2000
```

Each `alternatives` entry retains its ID, snapshot revision and independent
statements. A body statement for the first record has source `<keep-id>#/body`,
range `[0, 47)`, and text `Lower latency. Unresolved: eviction complexity.`.
The second record retains the opposing proposal and its cold-start tradeoff.
Neither record becomes a recommendation.

For each statement, read the native source row, follow the JSON Pointer and
compare `String(value).slice(start, end)` with `text`. If a small budget omits
optional paragraphs, `omitted` increases and `restore` supplies the native read.
If even titles, statuses and recorded outcomes cannot fit, the command refuses
with `alternatives_budget` and a remedy instead of losing an alternative.
