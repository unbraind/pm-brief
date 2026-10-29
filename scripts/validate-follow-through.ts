import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { PmClient, certifyCompleteListResult, estimatePmOutputTokens } from "@unbrained/pm-cli/sdk";
import { buildDecisionFollowThroughBrief, readFollowThroughObservation, FollowThroughError } from "../follow-through.ts";

/** Hash every regular tracker file, without following symlinks or emitting content. */
async function snapshot(path: string, prefix = ""): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) for (const [key, hash] of await snapshot(join(path, entry.name), `${name}/`)) result.set(key, hash);
    else if (entry.isFile()) result.set(name, createHash("sha256").update(await readFile(join(path, entry.name))).digest("hex"));
  }
  return result;
}

const pmRoot = resolve(process.argv[2] ?? ".agents/pm");
const client = new PmClient({ pmRoot, author: "validation-reader", noExtensions: true });
const options = { pmRoot, client };
// Warm native derived read caches before measuring the immutable validation window.
const items = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items;
const before = await snapshot(pmRoot); const start = performance.now();
const decisions = items.filter(row => row.type === "Decision");
const refusals = new Map<string, number>(); let briefs = 0; let maxBytes = 0;
for (const decision of decisions) {
  let output: unknown;
  try { output = await buildDecisionFollowThroughBrief({ decision: decision.id }, options); briefs++; }
  catch (error) {
    if (!(error instanceof FollowThroughError)) throw error;
    refusals.set(error.code, (refusals.get(error.code) ?? 0) + 1);
    output = { code: error.code, remedy: error.remedy };
  }
  maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(output)));
}
const measurements = items.filter(row => row.actual_result?.trim()).slice(0, 3);
for (const item of measurements) {
  const observation = await readFollowThroughObservation(item.id, options);
  assert.match(observation.revision, /^[a-f0-9]{64}$/);
  maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(observation)));
}
assert.deepEqual(certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items, items);
const after = await snapshot(pmRoot);
const changed = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path));
assert.deepEqual(changed, [], "Validation must not modify any tracker file, including native runtime caches");
process.stdout.write(`${JSON.stringify({
  items: items.length, decisions: decisions.length,
  explicitDeclarations: decisions.filter(row => row.brief_follow_through !== undefined).length,
  successfulBriefs: briefs, refusals: Object.fromEntries(refusals),
  observationRevisions: measurements.length, maxResponseBytes: maxBytes,
  maxEstimatedTokens: estimatePmOutputTokens(maxBytes),
  trackerFilesChecked: before.size, trackerFilesChanged: changed.length,
  elapsedMs: Math.ceil(performance.now() - start),
})}\n`);
