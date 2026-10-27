/** Measure action previews on an explicitly supplied public, non-git tracker copy. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PmClient, certifyCompleteListResult, estimatePmOutputTokens } from "@unbrained/pm-cli/sdk";
import { buildActionPrerequisiteBrief } from "../action.ts";

/** Hash exact files and relative identities; never emit tracker content or host paths. */
async function fingerprint(directory: string): Promise<string> {
  const hash = createHash("sha256");
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    hash.update(entry.name); const path = join(directory, entry.name);
    hash.update(entry.isDirectory() ? await fingerprint(path) : await readFile(path));
  }
  return hash.digest("hex");
}
/** Make only the caller-supplied disposable copy physically read-only during measurement. */
async function permissions(directory: string, writable: boolean): Promise<void> {
  if (writable) await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await permissions(path, writable);
    else await chmod(path, writable ? 0o600 : 0o400);
  }
  if (!writable) await chmod(directory, 0o500);
}

if (process.argv.length !== 3) throw new Error("Supply exactly one disposable public tracker copy");
const pmRoot = resolve(process.argv[2]);
const before = await fingerprint(pmRoot);
await permissions(pmRoot, false);
try {
  const client = new PmClient({ pmRoot, noExtensions: true });
  const items = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items;
  const started = performance.now();
  let missingInputs = 0; let unresolvedPrerequisites = 0; let satisfiedReferences = 0; let refusals = 0; let maxJsonBytes = 0; let maxEstimatedTokens = 0;
  for (const item of items) {
    const result = await buildActionPrerequisiteBrief({ command: "close", item: item.id, tokenBudget: 64000 }, { pmRoot, client });
    const jsonBytes = Buffer.byteLength(JSON.stringify(result, null, 2) + "\n");
    assert.ok(estimatePmOutputTokens(jsonBytes) <= result.estimatedTokenCeiling);
    assert.ok(Number.isSafeInteger(result.estimatedTokenCeiling) && result.estimatedTokenCeiling <= 64000);
    missingInputs += result.checklist.filter(row => row.kind === "input" && row.state === "missing").length;
    unresolvedPrerequisites += result.checklist.filter(row => row.kind === "prerequisite" && row.state === "unresolved").length;
    satisfiedReferences += result.checklist.filter(row => row.state === "satisfied" && row.ref).length;
    refusals += result.refusals.length;
    maxJsonBytes = Math.max(maxJsonBytes, jsonBytes); maxEstimatedTokens = Math.max(maxEstimatedTokens, result.estimatedTokenCeiling);
  }
  assert.equal(await fingerprint(pmRoot), before, "Read-only preview changed tracker bytes");
  console.log(JSON.stringify({ source: "public pm-brief origin/main tracker", items: items.length, previews: items.length, missingInputs, unresolvedPrerequisites, satisfiedReferences, refusals, maxJsonBytes, maxEstimatedTokens, elapsedMs: Math.round(performance.now() - started), trackerByteChanges: 0, sourceFingerprint: before }, null, 2));
} finally { await permissions(pmRoot, true); }
