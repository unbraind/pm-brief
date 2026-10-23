# Share a stakeholder brief

With pm-brief installed in a plain initialized tracker:

```bash
pm brief disclose --audience public
pm --json brief disclose --audience external --dry-run
```

The first command returns a brief with public item metadata. The second returns
only counts and exclusion paths, such as:

```json
{"profile":{"/focus/*/assignee":2},"policy":{},"secret":{},"unknown_field":{"/@8":1},"invalid_value":{}}
```

This fragment is the `exclusions` field, not a complete command result. A secret
in an allowed title removes the whole title; its value is never shown as an
excerpt. Unrecognized keys appear as ordinal references rather than their text.

To remove titles too, save a policy file:

```json
{"profile":"public","exclude":["focus.*.title","next.*.title","decisionsNeeded.*.title"]}
```

```bash
pm --json brief disclose --policy disclosure.json --dry-run
pm --json brief disclose --policy disclosure.json
```

Adding `allow`, a misspelled selector, or an unknown audience refuses with exit
2 and a remedy. The policy cannot widen an audience, even for an internal caller.

## Replay a public tracker read-only

Export a public repository's committed tracker to a disposable directory outside
git, without its extensions. Point `PUBLIC_TRACKER` at that exported `.agents/pm`
directory. Run this from an installed pm-brief SDK consumer. The export is the
read-only source; no hosted or private tracker is needed. This example copies
only the exported public data and deletes only its own disposable copy.

```js
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { PmClient, certifyCompleteListResult } from "@unbrained/pm-cli/sdk";
import { buildDisclosureBrief } from "pm-brief";

async function fingerprint(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const hash = createHash("sha256");
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(entry.name);
    hash.update(entry.isDirectory()
      ? await fingerprint(join(path, entry.name))
      : await readFile(join(path, entry.name)));
  }
  return hash.digest("hex");
}
async function protect(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await protect(child);
    else await chmod(child, 0o444);
  }
  await chmod(path, 0o555);
}
async function unprotect(path) {
  await chmod(path, 0o755);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await unprotect(join(path, entry.name));
  }
}
const source = process.env.PUBLIC_TRACKER;
assert.ok(source);
const sourceBefore = await fingerprint(source);
const scratch = await mkdtemp(join(tmpdir(), "public-disclosure-"));
const pmRoot = join(scratch, ".agents/pm");
process.env.GIT_CEILING_DIRECTORIES = dirname(scratch);
try {
  await cp(source, pmRoot, { recursive: true });
  await protect(pmRoot);
  const before = await fingerprint(pmRoot);
  const client = new PmClient({ pmRoot, noExtensions: true });
  const { items } = certifyCompleteListResult(await client.listAllComplete({ includeBody: true }));
  const results = [];
  for (const profile of ["internal", "external", "public"]) {
    const view = await buildDisclosureBrief({ profile }, { pmRoot, client });
    const dry = await buildDisclosureBrief({ profile }, { pmRoot, client, dryRun: true });
    assert.deepEqual(dry.exclusions, view.exclusions);
    assert.equal(dry.brief, undefined);
    results.push({ profile, bytes: Buffer.byteLength(JSON.stringify(view)),
      tokens: view.estimatedTokenCeiling, sourceTruncated: view.sourceTruncated,
      exclusions: Object.fromEntries(Object.entries(view.exclusions).map(([reason, paths]) =>
        [reason, Object.values(paths).reduce((sum, count) => sum + count, 0)])) });
  }
  assert.equal(await fingerprint(pmRoot), before);
  assert.equal(await fingerprint(source), sourceBefore);
  console.log(JSON.stringify({ items: items.length, uniqueIds: new Set(items.map(item => item.id)).size,
    unchangedSource: true, unchangedCopy: true, results }));
} finally {
  await unprotect(pmRoot);
  await rm(scratch, { recursive: true, force: true });
}
```

For reproducible numbers, supply the same `generatedAt` to each SDK call.
The replay measures rendering, source completeness and unchanged bytes; it does
not claim that heuristic secret recognition can classify arbitrary private prose.
