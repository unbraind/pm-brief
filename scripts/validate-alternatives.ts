import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { PmClient, certifyCompleteListResult, estimatePmOutputTokens } from "@unbrained/pm-cli/sdk";
import { buildDecisionAlternatives } from "../alternatives.ts";

/** Hash every source byte in an explicitly supplied tracker copy, without logging paths. */
async function fingerprint(directory: string): Promise<string> {
  const hash = createHash("sha256");
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    hash.update(entry.name);
    const path = join(directory, entry.name);
    hash.update(entry.isDirectory() ? await fingerprint(path) : await readFile(path));
  }
  return hash.digest("hex");
}

const pmRoot = resolve(process.argv[2]);
const ids = process.argv.slice(3);
const before = await fingerprint(pmRoot);
const client = new PmClient({ pmRoot, noExtensions: true });
const items = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items;
const started = performance.now();
const digest = await buildDecisionAlternatives(ids, { pmRoot, client });
const elapsedMs = Math.round(performance.now() - started);
let citations = 0;
for (const alternative of digest.alternatives) for (const statement of alternative.statements) {
  const [id, pointer] = statement.source.split("#");
  let value: unknown = items.find(item => item.id === id);
  for (const key of pointer.slice(1).split("/")) value = (value as Record<string, unknown>)[key.replace(/~1/g, "/").replace(/~0/g, "~")];
  assert.equal(String(value).slice(statement.start, statement.end), statement.text);
  citations++;
}
assert.equal(await fingerprint(pmRoot), before, "Tracker copy changed during read-only validation");
assert.ok(digest.estimatedTokenCeiling <= 4000);
process.stdout.write(`${JSON.stringify({ items: items.length, selected: ids, alternatives: digest.alternatives.length, citations, omitted: digest.alternatives.reduce((total, row) => total + row.omitted, 0), jsonBytes: Buffer.byteLength(JSON.stringify(digest, null, 2) + "\n"), jsonEstimatedTokens: estimatePmOutputTokens(Buffer.byteLength(JSON.stringify(digest, null, 2) + "\n")), estimatedTokenCeiling: digest.estimatedTokenCeiling, elapsedMs, unchanged: true, sourceFingerprint: before })}\n`);
